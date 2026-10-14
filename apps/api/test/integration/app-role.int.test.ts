import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  DeviceStatus,
  DeviceType,
  RoleStatus,
  TenantStatus,
  UserStatus,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { listTables } from "./table-audit.js";

// M1.14.2b: everything here runs logged in as the runtime role (erp_app of this run), with only the grants of
// infrastructure/postgres/03-runtime-grants.sql. The catalog side lives in runtime-privileges.int.test.ts.

const INSUFFICIENT_PRIVILEGE = "42501";
const TENANT_ID_IMMUTABLE = "23000";

/** SQLSTATE of a rejected Prisma call (model or raw), or "accepted" if it succeeded. */
async function sqlState(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return "accepted";
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause;
    return cause?.originalCode ?? `unknown: ${String(error)}`;
  }
}

describe("runtime role erp_app (PostgreSQL, logged in as erp_app)", () => {
  const appRole = inject("appRole");
  const migratorRole = inject("migratorRole");
  let app: PrismaClient;
  let owner: PrismaClient;

  beforeAll(() => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  /** A full tenant created by the runtime role itself (only the global permission comes from the deploy identity). */
  async function newOrg(name = "Tenant") {
    const tenant = await app.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await app.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = await app.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: "F", code: "MORUMBI", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const user = await app.user.create({
      data: { tenantId: tenant.id, name: "U", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE },
    });
    const access = await app.userBranchAccess.create({ data: { tenantId: tenant.id, userId: user.id, branchId: branch.id } });
    const role = await app.role.create({ data: { tenantId: tenant.id, code: "MANAGER", name: "Gerente", status: RoleStatus.ACTIVE } });
    const module = `t${randomUUID().slice(0, 8)}`;
    const permission = await owner.permission.create({ data: { code: `${module}.read`, module, description: "Teste" } });
    const rolePermission = await app.rolePermission.create({ data: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id } });
    const userRole = await app.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, branchId: branch.id } });
    const device = await app.device.create({
      data: { tenantId: tenant.id, branchId: branch.id, name: "pos", deviceType: DeviceType.POS, deviceKey: "pos-001", status: DeviceStatus.ACTIVE },
    });
    const session = await app.session.create({
      data: { tenantId: tenant.id, userId: user.id, deviceId: device.id, refreshTokenHash: `h1$${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const auditLog = await app.auditLog.create({
      data: { tenantId: tenant.id, userId: user.id, action: "user.created", resourceType: "user", resourceId: user.id },
    });
    return { tenant, company, branch, user, access, role, permission, rolePermission, userRole, device, session, auditLog };
  }

  it("really is connected as the runtime role, not as the migrator or a superuser", async () => {
    const [row] = await app.$queryRaw<{ user: string; session: string; superuser: string }[]>`
      SELECT current_user::text AS "user", session_user::text AS session, current_setting('is_superuser') AS superuser`;
    expect(row).toEqual({ user: appRole, session: appRole, superuser: "off" });
  });

  describe("allowed", () => {
    it("creates a whole tenant (INSERT on every runtime table, including audit_logs) and reads it back", async () => {
      const org = await newOrg();

      expect(await app.tenant.findUniqueOrThrow({ where: { id: org.tenant.id } })).toMatchObject({ name: "Tenant" });
      expect(await app.company.count({ where: { tenantId: org.tenant.id } })).toBe(1);
      expect(await app.userBranchAccess.count({ where: { tenantId: org.tenant.id } })).toBe(1);
      expect(await app.rolePermission.count({ where: { tenantId: org.tenant.id } })).toBe(1);
      expect(await app.userRole.count({ where: { tenantId: org.tenant.id } })).toBe(1);
      expect(await app.permission.findUniqueOrThrow({ where: { id: org.permission.id } })).toMatchObject({ code: org.permission.code });
      expect(await app.auditLog.findUniqueOrThrow({ where: { id: org.auditLog.id } })).toMatchObject({ action: "user.created" });
    });

    it("updates the mutable entities, including Session.revoked_at", async () => {
      const org = await newOrg();
      const revokedAt = new Date("2026-10-03T12:00:00.000Z");

      await app.tenant.update({ where: { id: org.tenant.id }, data: { name: "Novo" } });
      await app.company.update({ where: { id: org.company.id }, data: { tradeName: "Novo" } });
      await app.branch.update({ where: { id: org.branch.id }, data: { name: "Novo" } });
      await app.user.update({ where: { id: org.user.id }, data: { name: "Novo" } });
      await app.role.update({ where: { id: org.role.id }, data: { name: "Novo" } });
      await app.device.update({ where: { id: org.device.id }, data: { name: "Novo" } });
      expect((await app.session.update({ where: { id: org.session.id }, data: { revokedAt } })).revokedAt).toEqual(revokedAt);
    });

    it("deletes rows of the three link tables", async () => {
      const org = await newOrg();

      await app.userRole.delete({ where: { id: org.userRole.id } });
      await app.rolePermission.delete({ where: { id: org.rolePermission.id } });
      await app.userBranchAccess.delete({ where: { id: org.access.id } });

      expect(await app.userBranchAccess.count({ where: { tenantId: org.tenant.id } })).toBe(0);
      expect(await app.rolePermission.count({ where: { tenantId: org.tenant.id } })).toBe(0);
      expect(await app.userRole.count({ where: { tenantId: org.tenant.id } })).toBe(0);
    });

    it("still fires the protection triggers without EXECUTE on their functions", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      expect(await sqlState(app.company.update({ where: { id: a.company.id }, data: { tenantId: b.tenant.id } }))).toBe(TENANT_ID_IMMUTABLE);
      expect(await sqlState(app.$executeRaw`UPDATE sessions SET tenant_id = ${b.tenant.id}::uuid WHERE id = ${a.session.id}::uuid`)).toBe(
        TENANT_ID_IMMUTABLE,
      );
      expect((await app.company.findUniqueOrThrow({ where: { id: a.company.id } })).tenantId).toBe(a.tenant.id);
    });
  });

  describe("denied by privileges (42501), state unchanged", () => {
    it("cannot DELETE companies, users or devices (Prisma and SQL), nor any other mutable entity", async () => {
      const org = await newOrg();

      expect(await sqlState(app.company.delete({ where: { id: org.company.id } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.user.delete({ where: { id: org.user.id } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.device.delete({ where: { id: org.device.id } }))).toBe(INSUFFICIENT_PRIVILEGE);
      for (const [table, id] of [
        ["tenants", org.tenant.id],
        ["companies", org.company.id],
        ["branches", org.branch.id],
        ["users", org.user.id],
        ["roles", org.role.id],
        ["devices", org.device.id],
        ["sessions", org.session.id],
      ] as const) {
        expect(await sqlState(app.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = $1::uuid`, id)), table).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(await app.company.count({ where: { id: org.company.id } })).toBe(1);
      expect(await app.user.count({ where: { id: org.user.id } })).toBe(1);
      expect(await app.device.count({ where: { id: org.device.id } })).toBe(1);
    });

    it("cannot TRUNCATE any table", async () => {
      for (const table of await listTables(owner)) {
        expect(await sqlState(app.$executeRawUnsafe(`TRUNCATE "${table}"`)), table).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });

    it("cannot UPDATE the link tables", async () => {
      const org = await newOrg();

      expect(await sqlState(app.$executeRaw`UPDATE user_branch_access SET branch_id = branch_id WHERE id = ${org.access.id}::uuid`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(app.$executeRaw`UPDATE role_permissions SET role_id = role_id WHERE id = ${org.rolePermission.id}::uuid`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(app.userRole.update({ where: { id: org.userRole.id }, data: { branchId: null } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await app.userRole.findUniqueOrThrow({ where: { id: org.userRole.id } })).branchId).toBe(org.branch.id);
    });

    it("cannot write the global permissions catalog", async () => {
      const org = await newOrg();

      expect(await sqlState(app.permission.create({ data: { code: "x.read", module: "x", description: "x" } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.permission.update({ where: { id: org.permission.id }, data: { description: "y" } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.$executeRaw`DELETE FROM permissions WHERE id = ${org.permission.id}::uuid`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await app.permission.findUniqueOrThrow({ where: { id: org.permission.id } })).description).toBe("Teste");
    });

    it("cannot UPDATE, DELETE or TRUNCATE audit_logs: rejected by privileges before the append-only triggers", async () => {
      const org = await newOrg();

      expect(await sqlState(app.auditLog.update({ where: { id: org.auditLog.id }, data: { action: "x.y" } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.$executeRaw`UPDATE audit_logs SET action = 'x.y' WHERE id = ${org.auditLog.id}::uuid`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.auditLog.delete({ where: { id: org.auditLog.id } }))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.$executeRaw`DELETE FROM audit_logs WHERE id = ${org.auditLog.id}::uuid`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.$executeRawUnsafe("TRUNCATE audit_logs"))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await app.auditLog.findUniqueOrThrow({ where: { id: org.auditLog.id } })).toMatchObject({ action: "user.created" });
    });

    it("cannot read _prisma_migrations", async () => {
      expect(await sqlState(app.$queryRawUnsafe("SELECT count(*) FROM _prisma_migrations"))).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("denied: DDL, triggers, functions and escalation (42501)", () => {
    it.each([
      ["ALTER TABLE", "ALTER TABLE companies ADD COLUMN probe integer"],
      ["DROP TABLE", "DROP TABLE audit_logs"],
      ["DROP TRIGGER", "DROP TRIGGER audit_logs_append_only ON audit_logs"],
      ["DISABLE TRIGGER (append-only)", "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only"],
      ["DISABLE TRIGGER (tenant_id)", "ALTER TABLE companies DISABLE TRIGGER companies_tenant_id_immutable"],
      ["DISABLE TRIGGER ALL", "ALTER TABLE audit_logs DISABLE TRIGGER ALL"],
      ["CREATE TRIGGER", "CREATE TRIGGER probe BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation()"],
      ["CREATE TABLE in public", "CREATE TABLE public.probe (id integer)"],
      ["CREATE TABLE (default schema)", "CREATE TABLE probe (id integer)"],
      ["CREATE FUNCTION in public", "CREATE FUNCTION public.probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'"],
      [
        "CREATE OR REPLACE forbid_audit_log_mutation()",
        "CREATE OR REPLACE FUNCTION forbid_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'",
      ],
      [
        "CREATE OR REPLACE forbid_tenant_id_change()",
        "CREATE OR REPLACE FUNCTION forbid_tenant_id_change() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
      ],
      ["calling forbid_audit_log_mutation() directly", "SELECT forbid_audit_log_mutation()"],
      ["calling forbid_tenant_id_change() directly", "SELECT forbid_tenant_id_change()"],
      ["SET session_replication_role = replica", "SET session_replication_role = replica"],
      ["CREATE SCHEMA", "CREATE SCHEMA probe"],
    ])("rejects %s", async (_, statement) => {
      expect(await sqlState(app.$executeRawUnsafe(statement))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot SET ROLE to the migrator", async () => {
      expect(await sqlState(app.$executeRawUnsafe(`SET ROLE "${migratorRole}"`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("left every trigger in place and enabled, and the functions unchanged", async () => {
      const [row] = await owner.$queryRaw<{ enabled: number; total: number; probes: number }[]>`
        SELECT count(*) FILTER (WHERE tgenabled = 'O')::int AS enabled, count(*)::int AS total,
               count(*) FILTER (WHERE tgname = 'probe')::int AS probes
        FROM pg_trigger WHERE NOT tgisinternal`;
      expect(row).toEqual({ enabled: 11, total: 11, probes: 0 });
      const [replication] = await app.$queryRaw<{ value: string }[]>`SELECT current_setting('session_replication_role') AS value`;
      expect(replication?.value).toBe("origin");
      const functions = await owner.$queryRaw<{ name: string; body: string }[]>`
        SELECT p.proname::text AS name, p.prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' ORDER BY 1`;
      expect(functions.map((f) => f.name)).toEqual(["forbid_audit_log_mutation", "forbid_tenant_id_change"]);
      expect(functions[0]?.body).toContain("RAISE EXCEPTION");
      expect(functions[1]?.body).toContain("RAISE EXCEPTION");
    });
  });
});
