import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  DeviceStatus,
  DeviceType,
  Prisma,
  RoleStatus,
  TenantStatus,
  UserStatus,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import {
  GLOBAL_TABLES,
  MODEL_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
  classifyTable,
  checkConstraintViolations,
  compositeFkTargetViolations,
  credentialColumnViolations,
  foreignKeyCoverageViolations,
  foreignKeyViolations,
  listTables,
  ownershipViolations,
  partialIndexViolations,
  privilegeModelViolations,
  redundantIndexViolations,
  runtimePrivilegeViolations,
  tenantIdImmutabilityViolations,
  tenantScopeViolations,
  type DatabaseRoles,
} from "./table-audit.js";

// M1.14.4 — final gate of the M1 core. A small end-to-end smoke that proves the structural rules working together,
// executed as the real runtime identity (erp_app). The detailed cases stay in the per-model and audit files.

const FK_VIOLATION = "23503";
const TENANT_ID_IMMUTABLE = "23000";
const INSUFFICIENT_PRIVILEGE = "42501";

/** Editable tenant tables, all guarded by <table>_tenant_id_immutable. */
const EDITABLE_TENANT_TABLES = [
  "companies",
  "branches",
  "users",
  "user_branch_access",
  "roles",
  "role_permissions",
  "user_roles",
  "devices",
  "sessions",
] as const;

interface Rejection {
  code: string;
  message: string;
}

/** SQLSTATE and message of a rejected Prisma call (model or raw); code "accepted" if it succeeded. */
async function outcome(action: Promise<unknown>): Promise<Rejection> {
  try {
    await action;
    return { code: "accepted", message: "" };
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } }).meta
      ?.driverAdapterError?.cause;
    return { code: cause?.originalCode ?? `unknown: ${String(error)}`, message: cause?.originalMessage ?? "" };
  }
}

async function expectForeignKey(action: Promise<unknown>, constraint: string): Promise<void> {
  const result = await outcome(action);
  expect(result.code, `${constraint}: ${result.message}`).toBe(FK_VIOLATION);
  expect(result.message).toContain(`"${constraint}"`);
}

describe("M1 final gate (PostgreSQL)", () => {
  const roles: DatabaseRoles = { migrator: inject("migratorRole"), app: inject("appRole") };
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

  /** A global permission: catalog rows are written only by the deploy identity (seed as erp_migrator). */
  function catalogPermission() {
    const module = `g${randomUUID().slice(0, 8)}`;
    return owner.permission.create({ data: { code: `${module}.read`, module, description: "Gate" } });
  }

  /** A complete organization created by the runtime identity: two branches, the user has access to the first only. */
  async function newOrg(name: string) {
    const tenant = await app.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await app.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const [branch, otherBranch] = await Promise.all(
      ["MORUMBI", "IGUATEMI"].map((code) =>
        app.branch.create({
          data: { tenantId: tenant.id, companyId: company.id, name: code, code, status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
        }),
      ),
    );
    const user = await app.user.create({
      data: { tenantId: tenant.id, name: "U", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE },
    });
    const access = await app.userBranchAccess.create({ data: { tenantId: tenant.id, userId: user.id, branchId: branch!.id } });
    const role = await app.role.create({ data: { tenantId: tenant.id, code: "MANAGER", name: "Gerente", status: RoleStatus.ACTIVE } });
    const permission = await catalogPermission();
    const rolePermission = await app.rolePermission.create({ data: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id } });
    const userRole = await app.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, branchId: branch!.id } });
    const device = await app.device.create({
      data: { tenantId: tenant.id, branchId: branch!.id, name: "pos", deviceType: DeviceType.POS, deviceKey: "pos-001", status: DeviceStatus.ACTIVE },
    });
    const session = await app.session.create({
      data: { tenantId: tenant.id, userId: user.id, deviceId: device.id, refreshTokenHash: `h$${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const auditLog = await app.auditLog.create({
      data: { tenantId: tenant.id, userId: user.id, branchId: branch!.id, deviceId: device.id, action: "gate.created", resourceType: "tenant", resourceId: tenant.id },
    });
    return { tenant, company, branch: branch!, otherBranch: otherBranch!, user, access, role, permission, rolePermission, userRole, device, session, auditLog };
  }

  describe("structural state of M1", () => {
    it("has exactly the twelve M1 models, mapped to the expected tables, and no unexpected table", async () => {
      expect(Object.keys(Prisma.ModelName).sort()).toEqual(Object.keys(MODEL_TABLES).sort());
      expect(await listTables(owner)).toEqual([...Object.values(MODEL_TABLES), "_prisma_migrations"].sort());
    });

    it("keeps permissions as the only global business table and every other business table tenant-scoped", async () => {
      expect(GLOBAL_TABLES).toEqual(["permissions"]);
      const kinds = Object.fromEntries((await listTables(owner)).map((t) => [t, classifyTable(t)]));
      expect(kinds).toEqual({
        _prisma_migrations: "tooling",
        tenants: "root",
        permissions: "global",
        ...Object.fromEntries(EDITABLE_TENANT_TABLES.map((t) => [t, "tenant"])),
        audit_logs: "tenant",
      });
    });

    it("passes every fail-closed structural audit at once", async () => {
      const report: Record<string, string[]> = {
        tenantScope: await tenantScopeViolations(owner),
        foreignKeys: await foreignKeyViolations(owner),
        credentials: await credentialColumnViolations(owner),
        tenantIdImmutability: await tenantIdImmutabilityViolations(owner),
        runtimePrivileges: await runtimePrivilegeViolations(owner, roles.app),
        ownership: await ownershipViolations(owner, roles),
        privilegeModel: await privilegeModelViolations(owner, roles),
        fkCoverage: await foreignKeyCoverageViolations(owner),
        redundantIndexes: await redundantIndexViolations(owner),
        compositeFkTargets: await compositeFkTargetViolations(owner),
        partialIndexes: await partialIndexViolations(owner),
        checks: await checkConstraintViolations(owner),
      };
      expect(report).toEqual(Object.fromEntries(Object.keys(report).map((k) => [k, []])));
    });

    it("uses no CASCADE, SET NULL or SET DEFAULT in any FK", async () => {
      const [row] = await owner.$queryRaw<{ total: number; restrict: number }[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE confupdtype = 'r' AND confdeltype = 'r')::int AS restrict
        FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`;
      expect(row).toEqual({ total: 24, restrict: 24 });
    });
  });

  describe("two tenants, as erp_app: no cross-tenant relation and no row moves between tenants", () => {
    let a: Awaited<ReturnType<typeof newOrg>>;
    let b: Awaited<ReturnType<typeof newOrg>>;

    beforeAll(async () => {
      a = await newOrg("Gate A");
      b = await newOrg("Gate B");
    });

    it("User A cannot be linked to Branch B (UserBranchAccess)", async () => {
      await expectForeignKey(
        app.userBranchAccess.create({ data: { tenantId: a.tenant.id, userId: a.user.id, branchId: b.branch.id } }),
        "user_branch_access_tenant_id_branch_id_fkey",
      );
      await expectForeignKey(
        app.userBranchAccess.create({ data: { tenantId: b.tenant.id, userId: a.user.id, branchId: b.branch.id } }),
        "user_branch_access_tenant_id_user_id_fkey",
      );
    });

    it("Role A cannot be given to User B (UserRole)", async () => {
      await expectForeignKey(
        app.userRole.create({ data: { tenantId: a.tenant.id, userId: b.user.id, roleId: a.role.id } }),
        "user_roles_tenant_id_user_id_fkey",
      );
      await expectForeignKey(
        app.userRole.create({ data: { tenantId: b.tenant.id, userId: b.user.id, roleId: a.role.id } }),
        "user_roles_tenant_id_role_id_fkey",
      );
    });

    it("Branch A cannot point to Company B (insert and update)", async () => {
      await expectForeignKey(
        app.branch.create({
          data: { tenantId: a.tenant.id, companyId: b.company.id, name: "X", code: "X", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
        }),
        "branches_tenant_id_company_id_fkey",
      );
      await expectForeignKey(
        app.$executeRaw`UPDATE branches SET company_id = ${b.company.id}::uuid WHERE id = ${a.branch.id}::uuid`,
        "branches_tenant_id_company_id_fkey",
      );
    });

    it("Device A cannot point to Branch B (insert and update)", async () => {
      await expectForeignKey(
        app.device.create({
          data: { tenantId: a.tenant.id, branchId: b.branch.id, name: "x", deviceType: DeviceType.POS, deviceKey: "x", status: DeviceStatus.ACTIVE },
        }),
        "devices_tenant_id_branch_id_fkey",
      );
      await expectForeignKey(app.device.update({ where: { id: a.device.id }, data: { branchId: b.branch.id } }), "devices_tenant_id_branch_id_fkey");
    });

    it("Session A cannot point to User B or Device B (insert and update)", async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      await expectForeignKey(
        app.session.create({ data: { tenantId: a.tenant.id, userId: b.user.id, refreshTokenHash: `h$${randomUUID()}`, expiresAt } }),
        "sessions_tenant_id_user_id_fkey",
      );
      await expectForeignKey(
        app.session.create({ data: { tenantId: a.tenant.id, userId: a.user.id, deviceId: b.device.id, refreshTokenHash: `h$${randomUUID()}`, expiresAt } }),
        "sessions_tenant_id_device_id_fkey",
      );
      await expectForeignKey(app.session.update({ where: { id: a.session.id }, data: { deviceId: b.device.id } }), "sessions_tenant_id_device_id_fkey");
    });

    it("RolePermission does not accept Role B under tenant A", async () => {
      await expectForeignKey(
        app.rolePermission.create({ data: { tenantId: a.tenant.id, roleId: b.role.id, permissionId: a.permission.id } }),
        "role_permissions_tenant_id_role_id_fkey",
      );
    });

    it("UserRole does not accept a branch scope without UserBranchAccess (same tenant, and other tenant's branch)", async () => {
      await expectForeignKey(
        app.userRole.create({ data: { tenantId: a.tenant.id, userId: a.user.id, roleId: a.role.id, branchId: a.otherBranch.id } }),
        "user_roles_tenant_id_user_id_branch_id_fkey",
      );
      await expectForeignKey(
        app.userRole.create({ data: { tenantId: a.tenant.id, userId: a.user.id, roleId: a.role.id, branchId: b.branch.id } }),
        "user_roles_tenant_id_user_id_branch_id_fkey",
      );
    });

    it("AuditLog A cannot reference User, Branch or Device B", async () => {
      const base = { tenantId: a.tenant.id, action: "gate.probe", resourceType: "tenant" };
      await expectForeignKey(app.auditLog.create({ data: { ...base, userId: b.user.id } }), "audit_logs_tenant_id_user_id_fkey");
      await expectForeignKey(app.auditLog.create({ data: { ...base, branchId: b.branch.id } }), "audit_logs_tenant_id_branch_id_fkey");
      await expectForeignKey(app.auditLog.create({ data: { ...base, deviceId: b.device.id } }), "audit_logs_tenant_id_device_id_fkey");
    });

    it("no tenant_id can change afterwards: every editable table rejects it, audit_logs too", async () => {
      const rows: Record<(typeof EDITABLE_TENANT_TABLES)[number], string> = {
        companies: a.company.id,
        branches: a.branch.id,
        users: a.user.id,
        user_branch_access: a.access.id,
        roles: a.role.id,
        role_permissions: a.rolePermission.id,
        user_roles: a.userRole.id,
        devices: a.device.id,
        sessions: a.session.id,
      };
      for (const table of EDITABLE_TENANT_TABLES) {
        const result = await outcome(app.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = $1::uuid WHERE id = $2::uuid`, b.tenant.id, rows[table]));
        // The link tables have no UPDATE for erp_app, so the privilege check fires first; the trigger is the next barrier.
        const expected = RUNTIME_TABLE_PRIVILEGES[table]?.includes("UPDATE") ? TENANT_ID_IMMUTABLE : INSUFFICIENT_PRIVILEGE;
        expect(result.code, `${table}: ${result.message}`).toBe(expected);
      }
      expect((await outcome(app.$executeRaw`UPDATE audit_logs SET tenant_id = ${b.tenant.id}::uuid WHERE id = ${a.auditLog.id}::uuid`)).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );

      // Even the owner, who has every privilege, cannot move a row: the triggers reject it.
      for (const table of EDITABLE_TENANT_TABLES) {
        const result = await outcome(owner.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = $1::uuid WHERE id = $2::uuid`, b.tenant.id, rows[table]));
        expect(result.code, `${table} as owner: ${result.message}`).toBe(TENANT_ID_IMMUTABLE);
      }
      expect((await outcome(owner.$executeRaw`UPDATE audit_logs SET tenant_id = ${b.tenant.id}::uuid WHERE id = ${a.auditLog.id}::uuid`)).code).toBe("P0001");

      const moved = await owner.$queryRawUnsafe<{ table: string }[]>(
        [...EDITABLE_TENANT_TABLES, "audit_logs"]
          .map((t) => `SELECT '${t}' AS "table" FROM "${t}" WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`)
          .join(" UNION ALL "),
        b.tenant.id,
        [...Object.values(rows), a.auditLog.id],
      );
      expect(moved).toEqual([]);
    });
  });

  describe("runtime flow as erp_app: everything a normal request needs, nothing more", () => {
    it("runs the allowed M1 flow end to end with only the declared runtime matrix", async () => {
      const [identity] = await app.$queryRaw<{ user: string; superuser: string }[]>`
        SELECT current_user::text AS "user", current_setting('is_superuser') AS superuser`;
      expect(identity).toEqual({ user: roles.app, superuser: "off" });

      const created = await app.tenant.create({ data: { name: "Gate Flow", status: TenantStatus.TRIAL } });
      const permission = await catalogPermission();

      // 1. SELECT tenant (and the global catalog)
      const tenant = await app.tenant.findUniqueOrThrow({ where: { id: created.id } });
      expect(await app.permission.findUniqueOrThrow({ where: { code: permission.code } })).toMatchObject({ id: permission.id });
      // 2-11. INSERT company, branch, user, access, role, role permission, user role, device, session, audit log
      const company = await app.company.create({
        data: { tenantId: tenant.id, legalName: "Flow Ltda", tradeName: "Flow", cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
      });
      const branch = await app.branch.create({
        data: { tenantId: tenant.id, companyId: company.id, name: "Loja", code: "LOJA", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
      });
      const user = await app.user.create({
        data: { tenantId: tenant.id, name: "Ana", employeeNumber: "42", passwordHash: "hash", status: UserStatus.ACTIVE },
      });
      const access = await app.userBranchAccess.create({ data: { tenantId: tenant.id, userId: user.id, branchId: branch.id } });
      const role = await app.role.create({ data: { tenantId: tenant.id, code: "ATTENDANT", name: "Atendente", status: RoleStatus.ACTIVE } });
      await app.rolePermission.create({ data: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id } });
      const scoped = await app.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, branchId: branch.id } });
      await app.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
      const device = await app.device.create({
        data: { tenantId: tenant.id, branchId: branch.id, name: "Caixa 1", deviceType: DeviceType.POS, deviceKey: "caixa-1", status: DeviceStatus.ACTIVE },
      });
      const session = await app.session.create({
        data: { tenantId: tenant.id, userId: user.id, deviceId: device.id, refreshTokenHash: `h$${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) },
      });
      await app.auditLog.create({
        data: { tenantId: tenant.id, userId: user.id, branchId: branch.id, deviceId: device.id, action: "session.created", resourceType: "session", resourceId: session.id, metadata: { via: "gate" } },
      });
      // 12. UPDATE mutable entities (status changes, session revocation)
      await app.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });
      await app.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
      await app.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await app.user.update({ where: { id: user.id }, data: { status: UserStatus.DISABLED, disabledAt: new Date() } });
      // 13. DELETE allowed links (scoped role first: the access is RESTRICTed by it)
      await app.userRole.delete({ where: { id: scoped.id } });
      await app.userBranchAccess.delete({ where: { id: access.id } });

      expect(await app.userRole.count({ where: { tenantId: tenant.id } })).toBe(1);
      expect(await app.userBranchAccess.count({ where: { tenantId: tenant.id } })).toBe(0);
      expect(await app.auditLog.count({ where: { tenantId: tenant.id } })).toBe(1);
      expect((await app.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe(UserStatus.DISABLED);
      // The flow needed no privilege beyond the declared matrix: the effective grants are still exactly the policy.
      expect(await runtimePrivilegeViolations(owner, roles.app)).toEqual([]);
    });
  });
});
