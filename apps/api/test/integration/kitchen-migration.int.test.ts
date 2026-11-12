import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { PERMISSION_CATALOG, seedPermissions } from "../../src/database/seed/permissions.js";
import { BranchStatus, CompanyStatus, OrderStatus, RoleStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { DEFAULT_KITCHEN_SECTOR, DEFAULT_ROLE_PERMISSIONS } from "../../src/tenants/default-roles.js";
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
import { runtimePrivilegeViolations, saleImmutabilityViolations } from "./table-audit.js";
import { UUID_V7 } from "./uuid.js";

const M7_MIGRATION = "20261110020000_create_kitchen";
const apiRoot = fileURLToPath(new URL("../..", import.meta.url));
const forward = (path: string) => path.replace(/\\/g, "/");

/**
 * Incremental path of the M7 migration: a database migrated up to M6 WITH DATA (tenants, default and custom roles, a
 * confirmed order) receives 20261110020000_create_kitchen through the normal `prisma migrate deploy`, then the runtime
 * grants and the seed, exactly like a production deploy. Its own disposable database and roles (the shared one is
 * already fully migrated).
 */
describe("M7 migration on a database with M6 data (incremental path)", () => {
  let roles: TestRoles;
  let dbName: string;
  let migratorUrl: string;
  let db: PrismaClient;
  let partial: string;
  let deploy: { code: number; output: string };
  const ids = {} as Record<"tenantA" | "tenantB" | "ownerA" | "kitchenA" | "customA" | "customB" | "ownerB" | "order", string>;

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

    // 1. Every migration BEFORE M7, through a temporary Prisma config pointing at a copy of the migrations directory.
    partial = mkdtempSync(join(tmpdir(), "erp-m6-"));
    const migrations = join(apiRoot, "prisma", "migrations");
    for (const entry of readdirSync(migrations)) {
      // Only what came BEFORE M7 (later migrations, like KAN-41/42, are applied by the real deploy below, after M7).
      if (entry < M7_MIGRATION) cpSync(join(migrations, entry), join(partial, "migrations", entry), { recursive: true });
    }
    const config = join(partial, "prisma.config.mjs");
    writeFileSync(
      config,
      `export default { schema: ${JSON.stringify(forward(join(apiRoot, "prisma", "schema.prisma")))}, migrations: { path: ${JSON.stringify(forward(join(partial, "migrations")))} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    const m6 = await runPrisma(["migrate", "deploy", "--config", forward(config)], migratorUrl);
    if (m6.code !== 0) throw new Error(`migrate deploy up to M6 failed:\n${m6.output}`);

    // 2. M6 data (raw SQL where the M7 Prisma client would touch new columns).
    db = createPrismaClient(migratorUrl);
    // Catalog as it was at M6: without order.prepare (M7) and the audit permissions (KAN-41, a later migration).
    const later = new Set(["order.prepare", "audit.read", "audit.read_tenant"]);
    const preM7 = PERMISSION_CATALOG.filter((p) => !later.has(p.code));
    for (const p of preM7) await db.permission.create({ data: { code: p.code, module: p.module, description: p.description } });
    const permissions = new Map((await db.permission.findMany()).map((p) => [p.code, p.id]));
    const role = async (tenantId: string, code: string, isSystem: boolean, codes: readonly string[]) => {
      const r = await db.role.create({ data: { tenantId, code, name: code, isSystem, status: RoleStatus.ACTIVE } });
      for (const c of codes.filter((x) => !later.has(x))) await db.rolePermission.create({ data: { tenantId, roleId: r.id, permissionId: permissions.get(c)! } });
      return r.id;
    };
    const tenantA = await db.tenant.create({ data: { name: "M6 A", status: TenantStatus.ACTIVE } });
    const tenantB = await db.tenant.create({ data: { name: "M6 B", status: TenantStatus.ACTIVE } });
    ids.tenantA = tenantA.id;
    ids.tenantB = tenantB.id;
    ids.ownerA = await role(tenantA.id, "OWNER", true, DEFAULT_ROLE_PERMISSIONS.OWNER);
    await role(tenantA.id, "MANAGER", true, DEFAULT_ROLE_PERMISSIONS.MANAGER);
    await role(tenantA.id, "ATTENDANT", true, DEFAULT_ROLE_PERMISSIONS.ATTENDANT);
    ids.kitchenA = await role(tenantA.id, "KITCHEN", true, DEFAULT_ROLE_PERMISSIONS.KITCHEN);
    ids.customA = await role(tenantA.id, "CHEF", false, ["order.read", "order.create"]);
    ids.ownerB = await role(tenantB.id, "OWNER", true, DEFAULT_ROLE_PERMISSIONS.OWNER);
    // Tenant B has a CUSTOM role that took a default code: the backfill must not touch it.
    ids.customB = await role(tenantB.id, "KITCHEN", false, ["order.read"]);

    const company = await db.company.create({
      data: { tenantId: tenantA.id, legalName: "M6 Ltda", tradeName: "M6", cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = await db.branch.create({ data: { tenantId: tenantA.id, companyId: company.id, name: "Loja", code: "LOJA", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" } });
    const user = await db.user.create({ data: { tenantId: tenantA.id, name: "Ana", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE } });
    const [product] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO products (id, tenant_id, name, base_price, sort_order, status, updated_at)
      VALUES (gen_random_uuid(), ${tenantA.id}::uuid, 'X-Burger', 25.00, 0, 'ACTIVE', now()) RETURNING id::text AS id`;
    const order = await db.order.create({ data: { tenantId: tenantA.id, branchId: branch.id, status: OrderStatus.EDITING, total: "25.00", createdBy: user.id } });
    await db.orderItem.create({
      data: { tenantId: tenantA.id, orderId: order.id, productId: product!.id, productName: "X-Burger", quantity: 1, unitPrice: "25.00", lineTotal: "25.00", sortOrder: 0 },
    });
    await db.$executeRaw`UPDATE orders SET status = 'CONFIRMED', number = 1, business_date = '2026-11-09', confirmed_at = now() WHERE id = ${order.id}::uuid`;
    ids.order = order.id;

    // 3. The real deploy: pending migrations (M7 and the ones after it), runtime grants, then the seed.
    deploy = await runPrisma(["migrate", "deploy"], migratorUrl);
    if (deploy.code !== 0) throw new Error(`migrate deploy (M7) failed:\n${deploy.output}`);
    await runInfrastructureScript(migratorUrl, "03-runtime-grants.sql", roles);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (partial) rmSync(partial, { recursive: true, force: true });
    const serverUrl = testServerUrl();
    if (dbName) await dropDatabase(serverUrl, dbName);
    if (roles) await dropRoles(serverUrl, roles);
  });

  it("applies the M7 migration on top of M6 (then the later ones, in order)", async () => {
    expect(deploy.output).toContain(M7_MIGRATION);
    const rows = await db.$queryRaw<{ name: string }[]>`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 3`;
    expect(rows.map((r) => r.name)).toEqual(["20261111000000_audit_read_and_user_preferences", M7_MIGRATION, "20261110010000_adjust_order_immutability"]);
  });

  it("gives every existing tenant exactly one default sector 'Cozinha' (COZINHA), ACTIVE, with a UUIDv7 id", async () => {
    const sectors = await db.kitchenSector.findMany({ orderBy: { tenantId: "asc" } });
    expect(sectors.map((s) => s.tenantId).sort()).toEqual([ids.tenantA, ids.tenantB].sort());
    for (const s of sectors) {
      expect(s).toMatchObject({ name: DEFAULT_KITCHEN_SECTOR.name, code: DEFAULT_KITCHEN_SECTOR.code, isDefault: true, status: "ACTIVE", sortOrder: 0 });
      expect(s.id).toMatch(UUID_V7);
    }
  });

  it("adds order.prepare to the catalog and to the DEFAULT roles only (custom roles untouched, even with a default code)", async () => {
    const prepare = await db.permission.findUniqueOrThrow({ where: { code: "order.prepare" } });
    expect(prepare).toMatchObject({ module: "orders", description: "Preparar pedidos (cozinha)" });
    expect(prepare.id).toMatch(UUID_V7);
    const holders = await db.rolePermission.findMany({ where: { permissionId: prepare.id }, include: { role: { select: { id: true, code: true, isSystem: true } } } });
    expect(holders.map((h) => h.role.id).sort()).toEqual(
      [ids.ownerA, ids.kitchenA, ids.ownerB, ...(await db.role.findMany({ where: { tenantId: ids.tenantA, code: { in: ["MANAGER", "ATTENDANT"] } } })).map((r) => r.id)].sort(),
    );
    expect(holders.every((h) => h.role.isSystem)).toBe(true);
    for (const custom of [ids.customA, ids.customB]) {
      expect(await db.rolePermission.count({ where: { roleId: custom, permissionId: prepare.id } }), custom).toBe(0);
    }
    for (const h of holders) expect(h.id).toMatch(UUID_V7);
    // Other grants are untouched.
    expect(await db.rolePermission.count({ where: { roleId: ids.customB } })).toBe(1);
  });

  it("does not create tickets for orders confirmed before M7 (they keep the M5 flow)", async () => {
    expect(await db.kitchenTicket.count()).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: ids.order } })).status).toBe("CONFIRMED");
    expect((await db.product.findFirstOrThrow({ where: { tenantId: ids.tenantA } })).kitchenSectorId).toBeNull();
  });

  it("keeps the seed idempotent and aligned with the migrations (22 permissions, same description), and a re-deploy is a no-op", async () => {
    const before = await db.permission.findUniqueOrThrow({ where: { code: "order.prepare" } });
    expect(await seedPermissions(db)).toBe(22);
    expect(await seedPermissions(db)).toBe(22);
    expect(await db.permission.count()).toBe(22);
    expect(await db.permission.findUniqueOrThrow({ where: { code: "order.prepare" } })).toEqual(before);
    const again = await runPrisma(["migrate", "deploy"], migratorUrl);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toMatch(/No pending migrations/);
  });

  it("ends with the same runtime grants and sale guards as a clean database", async () => {
    expect(await runtimePrivilegeViolations(db, roles.app)).toEqual([]);
    expect(await saleImmutabilityViolations(db)).toEqual([]);
  });
});
