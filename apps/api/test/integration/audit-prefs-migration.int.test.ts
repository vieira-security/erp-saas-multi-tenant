import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { PERMISSION_CATALOG, seedPermissions } from "../../src/database/seed/permissions.js";
import { RoleStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { DEFAULT_ROLE_PERMISSIONS } from "../../src/tenants/default-roles.js";
import {
  createDisposableDatabase,
  databaseUrl,
  dropDatabase,
  dropRoles,
  runInfrastructureScript,
  runPrisma,
  setEphemeralPassword,
  testRoles,
  testServerUrl,
  type TestRoles,
} from "./database.js";
import { runtimePrivilegeViolations } from "./table-audit.js";
import { UUID_V7 } from "./uuid.js";

const MIGRATION = "20261111000000_audit_read_and_user_preferences";
const AUDIT = ["audit.read", "audit.read_tenant"];
const apiRoot = fileURLToPath(new URL("../..", import.meta.url));
const forward = (path: string) => path.replace(/\\/g, "/");

/**
 * Incremental path of the KAN-41/42 migration: a database migrated up to M7 WITH DATA (two tenants with default roles,
 * custom roles — one of them took a default code —, users and existing audit events) receives the migration through the
 * normal `prisma migrate deploy`, then the runtime grants and the seed, like a production deploy.
 */
describe("KAN-41/42 migration on a database with M7 data (incremental path)", () => {
  let roles: TestRoles;
  let dbName: string;
  let migratorUrl: string;
  let db: PrismaClient;
  let partial: string;
  let deploy: { code: number; output: string };
  const ids = {} as Record<"tenantA" | "tenantB" | "ownerA" | "managerA" | "attendantA" | "kitchenA" | "ownerB" | "managerB" | "customA" | "customB", string>;
  let customGrantsBefore: Map<string, string[]>;
  let auditRowsBefore: number;

  beforeAll(async () => {
    const serverUrl = testServerUrl();
    roles = testRoles();
    const created = await createDisposableDatabase(serverUrl);
    dbName = created.name;
    const adminUrl = databaseUrl(serverUrl, dbName);
    await runInfrastructureScript(adminUrl, "01-bootstrap-roles.sql", roles);
    await runInfrastructureScript(adminUrl, "02-bootstrap-database.sql", roles);
    migratorUrl = databaseUrl(serverUrl, dbName, { user: roles.migrator, password: await setEphemeralPassword(adminUrl, roles.migrator) });
    await setEphemeralPassword(adminUrl, roles.app);

    // 1. Every migration BEFORE this one.
    partial = mkdtempSync(join(tmpdir(), "erp-m7-"));
    const migrations = join(apiRoot, "prisma", "migrations");
    for (const entry of readdirSync(migrations)) {
      if (entry < MIGRATION) cpSync(join(migrations, entry), join(partial, "migrations", entry), { recursive: true });
    }
    const config = join(partial, "prisma.config.mjs");
    writeFileSync(
      config,
      `export default { schema: ${JSON.stringify(forward(join(apiRoot, "prisma", "schema.prisma")))}, migrations: { path: ${JSON.stringify(forward(join(partial, "migrations")))} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    const m7 = await runPrisma(["migrate", "deploy", "--config", forward(config)], migratorUrl);
    if (m7.code !== 0) throw new Error(`migrate deploy up to M7 failed:\n${m7.output}`);

    // 2. M7 data: the catalog as it was (no audit permissions), default and custom roles, users, audit events.
    db = createPrismaClient(migratorUrl);
    // (order.prepare already exists: the M7 migration inserted it.)
    await db.permission.createMany({ data: PERMISSION_CATALOG.filter((x) => !AUDIT.includes(x.code)).map((p) => ({ ...p })), skipDuplicates: true });
    const permissions = new Map((await db.permission.findMany()).map((p) => [p.code, p.id]));
    const role = async (tenantId: string, code: string, isSystem: boolean, codes: readonly string[]) => {
      const r = await db.role.create({ data: { tenantId, code, name: code, isSystem, status: RoleStatus.ACTIVE } });
      for (const c of codes.filter((x) => !AUDIT.includes(x))) await db.rolePermission.create({ data: { tenantId, roleId: r.id, permissionId: permissions.get(c)! } });
      return r.id;
    };
    const tenantA = await db.tenant.create({ data: { name: "M7 A", status: TenantStatus.ACTIVE } });
    const tenantB = await db.tenant.create({ data: { name: "M7 B", status: TenantStatus.ACTIVE } });
    ids.tenantA = tenantA.id;
    ids.tenantB = tenantB.id;
    ids.ownerA = await role(tenantA.id, "OWNER", true, DEFAULT_ROLE_PERMISSIONS.OWNER);
    ids.managerA = await role(tenantA.id, "MANAGER", true, DEFAULT_ROLE_PERMISSIONS.MANAGER);
    ids.attendantA = await role(tenantA.id, "ATTENDANT", true, DEFAULT_ROLE_PERMISSIONS.ATTENDANT);
    ids.kitchenA = await role(tenantA.id, "KITCHEN", true, DEFAULT_ROLE_PERMISSIONS.KITCHEN);
    ids.customA = await role(tenantA.id, "AUDITOR", false, ["user.read", "order.read"]);
    ids.ownerB = await role(tenantB.id, "OWNER", true, DEFAULT_ROLE_PERMISSIONS.OWNER);
    // Tenant B: MANAGER is a CUSTOM role that took a default code; the backfill must not touch it.
    ids.managerB = await role(tenantB.id, "MANAGER", false, ["order.read"]);
    ids.customB = ids.managerB;
    const user = await db.user.create({ data: { tenantId: tenantA.id, name: "Ana", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE } });
    await db.auditLog.create({ data: { tenantId: tenantA.id, userId: user.id, action: "auth.login.succeeded", resourceType: "session" } });
    await db.auditLog.create({ data: { tenantId: tenantA.id, userId: user.id, action: "user.created", resourceType: "user", resourceId: user.id } });
    auditRowsBefore = await db.auditLog.count();
    customGrantsBefore = new Map();
    for (const id of [ids.customA, ids.customB]) {
      customGrantsBefore.set(id, (await db.rolePermission.findMany({ where: { roleId: id }, select: { id: true } })).map((r) => r.id).sort());
    }

    // 3. The real deploy: pending migrations (only this one), runtime grants.
    deploy = await runPrisma(["migrate", "deploy"], migratorUrl);
    if (deploy.code !== 0) throw new Error(`migrate deploy (${MIGRATION}) failed:\n${deploy.output}`);
    await runInfrastructureScript(migratorUrl, "03-runtime-grants.sql", roles);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (partial) rmSync(partial, { recursive: true, force: true });
    const serverUrl = testServerUrl();
    if (dbName) await dropDatabase(serverUrl, dbName);
    if (roles) await dropRoles(serverUrl, roles);
  });

  it("applies only this migration on top of M7", async () => {
    expect(deploy.output).toContain(MIGRATION);
    const rows = await db.$queryRaw<{ name: string }[]>`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 2`;
    expect(rows.map((r) => r.name)).toEqual([MIGRATION, "20261110020000_create_kitchen"]);
  });

  it("adds audit.read and audit.read_tenant to the catalog with the seed's module/description and UUIDv7 ids", async () => {
    for (const code of AUDIT) {
      const permission = await db.permission.findUniqueOrThrow({ where: { code } });
      const expected = PERMISSION_CATALOG.find((p) => p.code === code)!;
      expect(permission).toMatchObject({ module: expected.module, description: expected.description });
      expect(permission.id).toMatch(UUID_V7);
    }
  });

  it("backfills only the DEFAULT roles: audit.read to OWNER and MANAGER, audit.read_tenant to OWNER", async () => {
    const holders = async (code: string) =>
      (await db.rolePermission.findMany({ where: { permission: { code } }, select: { roleId: true, id: true, role: { select: { isSystem: true } } } }));
    const read = await holders("audit.read");
    const tenant = await holders("audit.read_tenant");
    expect(read.map((h) => h.roleId).sort()).toEqual([ids.ownerA, ids.managerA, ids.ownerB].sort());
    expect(tenant.map((h) => h.roleId).sort()).toEqual([ids.ownerA, ids.ownerB].sort());
    for (const h of [...read, ...tenant]) {
      expect(h.role.isSystem).toBe(true);
      expect(h.id).toMatch(UUID_V7);
    }
    // Custom roles (including the one with the MANAGER code) are exactly as before.
    for (const [roleId, before] of customGrantsBefore) {
      expect((await db.rolePermission.findMany({ where: { roleId }, select: { id: true } })).map((r) => r.id).sort(), roleId).toEqual(before);
    }
    // Default roles now match the matrix.
    const codesOf = async (roleId: string) => (await db.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { code: true } } } })).map((r) => r.permission.code).sort();
    expect(await codesOf(ids.ownerA)).toEqual([...DEFAULT_ROLE_PERMISSIONS.OWNER].sort());
    expect(await codesOf(ids.managerA)).toEqual([...DEFAULT_ROLE_PERMISSIONS.MANAGER].sort());
    expect(await codesOf(ids.attendantA)).toEqual([...DEFAULT_ROLE_PERMISSIONS.ATTENDANT].sort());
    expect(await codesOf(ids.kitchenA)).toEqual([...DEFAULT_ROLE_PERMISSIONS.KITCHEN].sort());
  });

  it("creates an empty user_preferences and leaves the existing audit events untouched", async () => {
    expect(await db.userPreference.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(auditRowsBefore);
  });

  it("keeps the seed idempotent and aligned (22 permissions), and a re-deploy is a no-op", async () => {
    const before = await db.permission.findMany({ where: { code: { in: AUDIT } }, orderBy: { code: "asc" } });
    expect(await seedPermissions(db)).toBe(22);
    expect(await seedPermissions(db)).toBe(22);
    expect(await db.permission.count()).toBe(22);
    expect(await db.permission.findMany({ where: { code: { in: AUDIT } }, orderBy: { code: "asc" } })).toEqual(before);
    const again = await runPrisma(["migrate", "deploy"], migratorUrl);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toMatch(/No pending migrations/);
  });

  it("ends with the same runtime grants as a clean database (user_preferences without DELETE, audit_logs append-only)", async () => {
    expect(await runtimePrivilegeViolations(db, roles.app)).toEqual([]);
    const grants = await db.$queryRaw<{ table: string; privilege: string }[]>`
      SELECT table_name AS "table", privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = ${roles.app} AND table_name IN ('user_preferences', 'audit_logs') ORDER BY table_name, privilege_type`;
    expect(grants).toEqual([
      { table: "audit_logs", privilege: "INSERT" },
      { table: "audit_logs", privilege: "SELECT" },
      { table: "user_preferences", privilege: "INSERT" },
      { table: "user_preferences", privilege: "SELECT" },
      { table: "user_preferences", privilege: "UPDATE" },
    ]);
  });
});
