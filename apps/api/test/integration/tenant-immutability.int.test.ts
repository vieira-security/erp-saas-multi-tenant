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
import { expectTenantIdImmutable } from "./tenant-immutability.js";

// M1.14.1: tenant_id never changes once a tenant row exists (trigger <table>_tenant_id_immutable, shared function
// forbid_tenant_id_change()). Per-entity "move" cases live in each model's test; this file covers every editable
// tenant table uniformly, normal updates, no-op updates and SQL/Prisma paths that could try to sidestep the rule.

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
type EditableTable = (typeof EDITABLE_TENANT_TABLES)[number];

describe("tenant_id immutability (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant with one row in every editable tenant table, keyed by table. */
  async function newOrg(name: string) {
    const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await prisma.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = await prisma.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: "F", code: "MORUMBI", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, name: "U", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE },
    });
    const access = await prisma.userBranchAccess.create({ data: { tenantId: tenant.id, userId: user.id, branchId: branch.id } });
    const role = await prisma.role.create({ data: { tenantId: tenant.id, code: "MANAGER", name: "Gerente", status: RoleStatus.ACTIVE } });
    const module = `t${Math.random().toString(16).slice(2, 10)}`;
    const permission = await prisma.permission.create({ data: { code: `${module}.read`, module, description: "Teste" } });
    const rolePermission = await prisma.rolePermission.create({ data: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id } });
    const userRole = await prisma.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, branchId: branch.id } });
    const device = await prisma.device.create({
      data: { tenantId: tenant.id, branchId: branch.id, name: "pos", deviceType: DeviceType.POS, deviceKey: "pos-001", status: DeviceStatus.ACTIVE },
    });
    const session = await prisma.session.create({
      data: { tenantId: tenant.id, userId: user.id, deviceId: device.id, refreshTokenHash: `h1$${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const ids: Record<EditableTable, string> = {
      companies: company.id,
      branches: branch.id,
      users: user.id,
      user_branch_access: access.id,
      roles: role.id,
      role_permissions: rolePermission.id,
      user_roles: userRole.id,
      devices: device.id,
      sessions: session.id,
    };
    return { tenantId: tenant.id, company, branch, user, role, device, session, ids };
  }

  async function tenantOf(table: EditableTable, id: string): Promise<string | undefined> {
    const [row] = await prisma.$queryRawUnsafe<{ tenantId: string }[]>(
      `SELECT tenant_id::text AS "tenantId" FROM "${table}" WHERE id = $1::uuid`,
      id,
    );
    return row?.tenantId;
  }

  describe("every editable tenant table", () => {
    it.each(EDITABLE_TENANT_TABLES)("%s: rejects a direct SQL tenant_id change and keeps the row", async (table) => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expectTenantIdImmutable(
        prisma.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = $1::uuid WHERE id = $2::uuid`, b.tenantId, a.ids[table]),
        table,
      );
      expect(await tenantOf(table, a.ids[table])).toBe(a.tenantId);
    });

    it.each(EDITABLE_TENANT_TABLES)("%s: accepts SET tenant_id = tenant_id and the same UUID (no real change)", async (table) => {
      const a = await newOrg("A");

      expect(await prisma.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = tenant_id WHERE id = $1::uuid`, a.ids[table])).toBe(1);
      expect(
        await prisma.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = $1::uuid WHERE id = $2::uuid`, a.tenantId, a.ids[table]),
      ).toBe(1);
      expect(await tenantOf(table, a.ids[table])).toBe(a.tenantId);
    });
  });

  describe("normal updates inside the same tenant keep working", () => {
    it("updates Company.trade_name, Branch.name, User.name, Role.name, Device.name and Session.revoked_at (Prisma)", async () => {
      const a = await newOrg("A");
      const revokedAt = new Date("2026-10-03T12:00:00.000Z");

      expect((await prisma.company.update({ where: { id: a.company.id }, data: { tradeName: "Novo Nome" } })).tradeName).toBe("Novo Nome");
      expect((await prisma.branch.update({ where: { id: a.branch.id }, data: { name: "Filial Nova" } })).name).toBe("Filial Nova");
      expect((await prisma.user.update({ where: { id: a.user.id }, data: { name: "Maria" } })).name).toBe("Maria");
      expect((await prisma.role.update({ where: { id: a.role.id }, data: { name: "Gerência" } })).name).toBe("Gerência");
      expect((await prisma.device.update({ where: { id: a.device.id }, data: { name: "Caixa 2" } })).name).toBe("Caixa 2");
      expect((await prisma.session.update({ where: { id: a.session.id }, data: { revokedAt } })).revokedAt).toEqual(revokedAt);
    });

    it("updates the same columns via SQL, also when tenant_id is in the SET list with its own value", async () => {
      const a = await newOrg("A");

      expect(await prisma.$executeRaw`UPDATE companies SET trade_name = 'SQL', tenant_id = tenant_id WHERE id = ${a.company.id}::uuid`).toBe(1);
      expect(await prisma.$executeRaw`UPDATE branches SET name = 'SQL' WHERE id = ${a.branch.id}::uuid`).toBe(1);
      expect(await prisma.$executeRaw`UPDATE users SET name = 'SQL', tenant_id = ${a.tenantId}::uuid WHERE id = ${a.user.id}::uuid`).toBe(1);
      expect(await prisma.$executeRaw`UPDATE roles SET name = 'SQL' WHERE id = ${a.role.id}::uuid`).toBe(1);
      expect(await prisma.$executeRaw`UPDATE devices SET name = 'SQL' WHERE id = ${a.device.id}::uuid`).toBe(1);
      expect(await prisma.$executeRaw`UPDATE sessions SET revoked_at = now() WHERE id = ${a.session.id}::uuid`).toBe(1);
    });

    it("accepts a Prisma update that repeats the current tenantId or reconnects the same tenant", async () => {
      const a = await newOrg("A");

      expect((await prisma.role.update({ where: { id: a.role.id }, data: { tenantId: a.tenantId, name: "X" } })).tenantId).toBe(a.tenantId);
      expect(
        (await prisma.company.update({ where: { id: a.company.id }, data: { tenant: { connect: { id: a.tenantId } } } })).tenantId,
      ).toBe(a.tenantId);
    });
  });

  describe("no path around the rule", () => {
    it("rejects a bulk UPDATE as a whole: no row moves", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await prisma.role.create({ data: { tenantId: a.tenantId, code: "ATTENDANT", name: "Atendente", status: RoleStatus.ACTIVE } });

      await expectTenantIdImmutable(prisma.$executeRaw`UPDATE roles SET tenant_id = ${b.tenantId}::uuid WHERE tenant_id = ${a.tenantId}::uuid`, "roles");
      await expectTenantIdImmutable(prisma.role.updateMany({ where: { tenantId: a.tenantId }, data: { tenantId: b.tenantId } }), "roles");
      expect(await prisma.role.count({ where: { tenantId: a.tenantId } })).toBe(2);
    });

    it("rejects tenant_id changes hidden in UPDATE ... FROM, a subquery, a CTE and alongside other columns", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE users u SET tenant_id = t.id FROM tenants t WHERE t.id = ${b.tenantId}::uuid AND u.id = ${a.user.id}::uuid`,
        "users",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE devices SET tenant_id = (SELECT id FROM tenants WHERE id = ${b.tenantId}::uuid) WHERE id = ${a.device.id}::uuid`,
        "devices",
      );
      await expectTenantIdImmutable(
        prisma.$queryRaw`WITH moved AS (UPDATE companies SET tenant_id = ${b.tenantId}::uuid WHERE id = ${a.company.id}::uuid RETURNING id)
                         SELECT count(*) FROM moved`,
        "companies",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE roles SET name = 'Movida', tenant_id = ${b.tenantId}::uuid WHERE id = ${a.role.id}::uuid`,
        "roles",
      );
      expect(await prisma.role.findUniqueOrThrow({ where: { id: a.role.id } })).toMatchObject({ tenantId: a.tenantId, name: "Gerente" });
    });

    it("rejects INSERT ... ON CONFLICT DO UPDATE and MERGE that would move an existing row", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expectTenantIdImmutable(
        prisma.$executeRaw`INSERT INTO roles (id, tenant_id, code, name, status, updated_at)
                           VALUES (${a.role.id}::uuid, ${b.tenantId}::uuid, 'MOVED', 'Movida', 'ACTIVE', now())
                           ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
        "roles",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`MERGE INTO branches t USING (SELECT ${a.branch.id}::uuid AS id) s ON t.id = s.id
                           WHEN MATCHED THEN UPDATE SET tenant_id = ${b.tenantId}::uuid, company_id = ${b.company.id}::uuid`,
        "branches",
      );
      expect(await tenantOf("roles", a.role.id)).toBe(a.tenantId);
      expect(await tenantOf("branches", a.branch.id)).toBe(a.tenantId);
    });

    it("rejects Prisma upsert, relation connect and a transaction that tries to move a row", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expectTenantIdImmutable(
        prisma.device.upsert({
          where: { id: a.device.id },
          create: { tenantId: b.tenantId, name: "x", deviceType: DeviceType.POS, deviceKey: "x", status: DeviceStatus.ACTIVE },
          update: { tenantId: b.tenantId, branchId: null },
        }),
        "devices",
      );
      await expectTenantIdImmutable(
        prisma.company.update({ where: { id: a.company.id }, data: { tenant: { connect: { id: b.tenantId } } } }),
        "companies",
      );
      await expectTenantIdImmutable(
        prisma.$transaction([
          prisma.user.update({ where: { id: a.user.id }, data: { name: "Antes" } }),
          prisma.user.update({ where: { id: a.user.id }, data: { tenantId: b.tenantId } }),
        ]),
        "users",
      );
      expect(await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).toMatchObject({ tenantId: a.tenantId, name: "U" });
      expect(await tenantOf("devices", a.device.id)).toBe(a.tenantId);
      expect(await tenantOf("companies", a.company.id)).toBe(a.tenantId);
    });
  });
});
