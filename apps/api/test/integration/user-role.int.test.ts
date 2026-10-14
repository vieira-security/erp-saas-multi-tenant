import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  RoleStatus,
  TenantStatus,
  UserStatus,
  type Branch,
  type PrismaClient,
  type Role,
  type User,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const USER_FK = /user_roles_tenant_id_user_id_fkey/;
const ROLE_FK = /user_roles_tenant_id_role_id_fkey/;
const ACCESS_FK = /user_roles_tenant_id_user_id_branch_id_fkey/;
const ANY_COMPOSITE_FK = /user_roles_tenant_id_(user_id|role_id|user_id_branch_id)_fkey/;
const TENANT_SCOPE_KEY = /user_roles_tenant_scope_key/;
const BRANCH_SCOPE_KEY = /user_roles_branch_scope_key/;

interface Org {
  tenantId: string;
  user: User;
  branchA: Branch;
  branchB: Branch;
  manager: Role;
  attendant: Role;
}

describe("UserRole (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant with one company, branches A/B, one user (no branch access yet) and roles MANAGER/ATTENDANT. */
  async function newOrg(name = "Tenant"): Promise<Org> {
    const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await prisma.company.create({
      data: {
        tenantId: tenant.id,
        legalName: `${name} Ltda`,
        tradeName: name,
        cnpj: "11222333000181",
        status: CompanyStatus.ACTIVE,
        timezone: "America/Sao_Paulo",
      },
    });
    const branch = (code: string) =>
      prisma.branch.create({
        data: { tenantId: tenant.id, companyId: company.id, name: code, code, status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
      });
    const role = (code: string) => prisma.role.create({ data: { tenantId: tenant.id, code, name: code, status: RoleStatus.ACTIVE } });
    return {
      tenantId: tenant.id,
      user: await addUser(tenant.id, "1001"),
      branchA: await branch("MORUMBI"),
      branchB: await branch("ELDORADO"),
      manager: await role("MANAGER"),
      attendant: await role("ATTENDANT"),
    };
  }

  function addUser(tenantId: string, employeeNumber: string) {
    return prisma.user.create({
      data: { tenantId, name: `Usuário ${employeeNumber}`, employeeNumber, passwordHash: "hash", status: UserStatus.ACTIVE },
    });
  }

  function grantAccess(tenantId: string, userId: string, branchId: string) {
    return prisma.userBranchAccess.create({ data: { tenantId, userId, branchId } });
  }

  function assign(tenantId: string, userId: string, roleId: string, branchId: string | null = null) {
    return prisma.userRole.create({ data: { tenantId, userId, roleId, branchId } });
  }

  function rawAssign(tenantId: string, userId: string, roleId: string, branchId: string | null = null) {
    return prisma.$executeRaw`
      INSERT INTO user_roles (id, tenant_id, user_id, role_id, branch_id)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${userId}::uuid, ${roleId}::uuid, ${branchId}::uuid)`;
  }

  describe("tenant-wide role (branch_id NULL)", () => {
    it("creates a valid global user-role", async () => {
      const org = await newOrg();
      const created = await assign(org.tenantId, org.user.id, org.manager.id);

      const loaded = await prisma.userRole.findUniqueOrThrow({
        where: { id: created.id },
        include: { user: true, role: true, tenant: true, branchAccess: true },
      });
      expect([loaded.user.id, loaded.role.id, loaded.tenant.id]).toEqual([org.user.id, org.manager.id, org.tenantId]);
      expect(loaded.branchId).toBeNull();
      expect(loaded.branchAccess).toBeNull();
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const org = await newOrg();
      const before = Date.now();
      const created = await assign(org.tenantId, org.user.id, org.manager.id);
      const after = Date.now();

      expect(created.id).toMatch(UUID_V7);
      expect(uuidV7Millis(created.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(created.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string; branchIsNull: boolean }[]>`
        SELECT pg_typeof(id)::text AS type, branch_id IS NULL AS "branchIsNull"
        FROM user_roles WHERE id = ${created.id}::uuid`;
      expect(row).toEqual({ type: "uuid", branchIsNull: true });
    });

    it("does not require any UserBranchAccess (MATCH SIMPLE skips the access FK when branch_id is NULL)", async () => {
      const org = await newOrg();
      expect(await prisma.userBranchAccess.count({ where: { userId: org.user.id } })).toBe(0);

      await expect(assign(org.tenantId, org.user.id, org.manager.id)).resolves.toBeTruthy();
      await expect(rawAssign(org.tenantId, org.user.id, org.attendant.id)).resolves.toBe(1);
    });

    it("rejects the same global role twice: NULL does not bypass uniqueness (Prisma and SQL)", async () => {
      const org = await newOrg();
      await assign(org.tenantId, org.user.id, org.manager.id);

      await expect(assign(org.tenantId, org.user.id, org.manager.id)).rejects.toThrow(TENANT_SCOPE_KEY);
      await expect(rawAssign(org.tenantId, org.user.id, org.manager.id, null)).rejects.toThrow(TENANT_SCOPE_KEY);
      expect(await prisma.userRole.count({ where: { userId: org.user.id, roleId: org.manager.id, branchId: null } })).toBe(1);
    });

    it("lets one user have different global roles", async () => {
      const org = await newOrg();
      await assign(org.tenantId, org.user.id, org.manager.id);
      await assign(org.tenantId, org.user.id, org.attendant.id);

      expect(await prisma.userRole.count({ where: { userId: org.user.id, branchId: null } })).toBe(2);
    });
  });

  describe("branch-scoped role", () => {
    it("creates a valid branch-scoped user-role when the user has access to the branch", async () => {
      const org = await newOrg();
      const access = await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      const created = await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);

      const loaded = await prisma.userRole.findUniqueOrThrow({ where: { id: created.id }, include: { branchAccess: true } });
      expect(loaded.branchId).toBe(org.branchA.id);
      expect(loaded.branchAccess?.id).toBe(access.id);
    });

    it("rejects a user without access to the branch (Prisma and SQL)", async () => {
      const org = await newOrg();

      await expect(assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawAssign(org.tenantId, org.user.id, org.manager.id, org.branchA.id)).rejects.toThrow(ACCESS_FK);
    });

    it("does not accept access to another branch as sufficient", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchB.id);

      await expect(assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawAssign(org.tenantId, org.user.id, org.manager.id, org.branchA.id)).rejects.toThrow(ACCESS_FK);
    });

    it("rejects a branch of another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(a.tenantId, a.user.id, a.branchA.id);

      await expect(assign(a.tenantId, a.user.id, a.manager.id, b.branchA.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawAssign(a.tenantId, a.user.id, a.manager.id, b.branchA.id)).rejects.toThrow(ACCESS_FK);
    });

    it("rejects a user of another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(b.tenantId, b.user.id, b.branchA.id);

      for (const branchId of [null, a.branchA.id]) {
        await expect(assign(a.tenantId, b.user.id, a.manager.id, branchId)).rejects.toMatchObject({ code: "P2003" });
        await expect(rawAssign(a.tenantId, b.user.id, a.manager.id, branchId)).rejects.toThrow(ANY_COMPOSITE_FK);
      }
    });

    it("rejects a role of another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(a.tenantId, a.user.id, a.branchA.id);

      for (const branchId of [null, a.branchA.id]) {
        await expect(assign(a.tenantId, a.user.id, b.manager.id, branchId)).rejects.toMatchObject({ code: "P2003" });
        await expect(rawAssign(a.tenantId, a.user.id, b.manager.id, branchId)).rejects.toThrow(ROLE_FK);
      }
    });

    it("rejects a wrong tenant_id even when user, role and branch match each other", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(a.tenantId, a.user.id, a.branchA.id);

      for (const tenantId of [b.tenantId, randomUUID()]) {
        await expect(assign(tenantId, a.user.id, a.manager.id, a.branchA.id)).rejects.toMatchObject({ code: "P2003" });
        await expect(rawAssign(tenantId, a.user.id, a.manager.id, a.branchA.id)).rejects.toThrow(/user_roles_tenant_id_\w*fkey/);
      }
    });

    it("rejects the same role twice in the same branch (Prisma and SQL)", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);

      await expect(assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id)).rejects.toThrow(BRANCH_SCOPE_KEY);
      await expect(rawAssign(org.tenantId, org.user.id, org.manager.id, org.branchA.id)).rejects.toThrow(BRANCH_SCOPE_KEY);
    });

    it("accepts the same role in different branches", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      await grantAccess(org.tenantId, org.user.id, org.branchB.id);

      await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);
      await assign(org.tenantId, org.user.id, org.manager.id, org.branchB.id);
      expect(await prisma.userRole.count({ where: { userId: org.user.id, roleId: org.manager.id } })).toBe(2);
    });

    it("accepts different roles in the same branch", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);

      await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);
      await assign(org.tenantId, org.user.id, org.attendant.id, org.branchA.id);
      expect(await prisma.userRole.count({ where: { userId: org.user.id, branchId: org.branchA.id } })).toBe(2);
    });

    it("lets a global role and the same role scoped to a branch coexist", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);

      await assign(org.tenantId, org.user.id, org.manager.id);
      await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);
      const rows = await prisma.userRole.findMany({ where: { userId: org.user.id, roleId: org.manager.id } });
      expect(rows.map((r) => r.branchId).sort()).toEqual([org.branchA.id, null].sort());
    });
  });

  describe("multi-tenant isolation on update", () => {
    it("rejects changing user_id to a user of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const created = await assign(a.tenantId, a.user.id, a.manager.id);

      await expect(prisma.userRole.update({ where: { id: created.id }, data: { userId: b.user.id } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.$executeRaw`UPDATE user_roles SET user_id = ${b.user.id}::uuid WHERE id = ${created.id}::uuid`,
      ).rejects.toThrow(USER_FK);
    });

    it("rejects changing role_id to a role of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const created = await assign(a.tenantId, a.user.id, a.manager.id);

      await expect(prisma.userRole.update({ where: { id: created.id }, data: { roleId: b.manager.id } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.$executeRaw`UPDATE user_roles SET role_id = ${b.manager.id}::uuid WHERE id = ${created.id}::uuid`,
      ).rejects.toThrow(ROLE_FK);
    });

    it("rejects changing branch_id to a branch without access, including from NULL (Prisma and SQL)", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      const scoped = await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);
      const global = await assign(org.tenantId, org.user.id, org.attendant.id);

      for (const { id } of [scoped, global]) {
        await expect(
          prisma.userRole.update({ where: { id }, data: { branchId: org.branchB.id } }),
        ).rejects.toMatchObject({ code: "P2003" });
        await expect(
          prisma.$executeRaw`UPDATE user_roles SET branch_id = ${org.branchB.id}::uuid WHERE id = ${id}::uuid`,
        ).rejects.toThrow(ACCESS_FK);
      }
    });

    it("rejects changing branch_id to a branch of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(a.tenantId, a.user.id, a.branchA.id);
      const created = await assign(a.tenantId, a.user.id, a.manager.id, a.branchA.id);

      await expect(
        prisma.userRole.update({ where: { id: created.id }, data: { branchId: b.branchA.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE user_roles SET branch_id = ${b.branchA.id}::uuid WHERE id = ${created.id}::uuid`,
      ).rejects.toThrow(ACCESS_FK);
    });

    it("rejects changing only tenant_id (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(a.tenantId, a.user.id, a.branchA.id);
      const global = await assign(a.tenantId, a.user.id, a.manager.id);
      const scoped = await assign(a.tenantId, a.user.id, a.attendant.id, a.branchA.id);

      for (const { id } of [global, scoped]) {
        await expectTenantIdImmutable(prisma.userRole.update({ where: { id }, data: { tenantId: b.tenantId } }), "user_roles");
        await expectTenantIdImmutable(
          prisma.$executeRaw`UPDATE user_roles SET tenant_id = ${b.tenantId}::uuid WHERE id = ${id}::uuid`,
          "user_roles",
        );
      }
    });

    it("blocks moving a user that has roles to another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await assign(a.tenantId, a.user.id, a.manager.id);

      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE users SET tenant_id = ${b.tenantId}::uuid, employee_number = 'X-1'
                           WHERE id = ${a.user.id}::uuid`,
        "users",
      );
    });

    // Formerly GAP (M1.14): consistent moves were accepted; user_roles_tenant_id_immutable now forbids them.
    it("blocks moving a whole user-role when tenant, user, role and branch change together (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grantAccess(a.tenantId, a.user.id, a.branchA.id);
      await grantAccess(b.tenantId, b.user.id, b.branchA.id);
      const created = await assign(a.tenantId, a.user.id, a.manager.id, a.branchA.id);

      await expectTenantIdImmutable(
        prisma.userRole.update({
          where: { id: created.id },
          data: { tenantId: b.tenantId, userId: b.user.id, roleId: b.manager.id, branchId: b.branchA.id },
        }),
        "user_roles",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE user_roles
                           SET tenant_id = ${b.tenantId}::uuid, user_id = ${b.user.id}::uuid,
                               role_id = ${b.manager.id}::uuid, branch_id = ${b.branchA.id}::uuid
                           WHERE id = ${created.id}::uuid`,
        "user_roles",
      );
      expect(await prisma.userRole.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        tenantId: a.tenantId,
        userId: a.user.id,
        roleId: a.manager.id,
        branchId: a.branchA.id,
      });
    });

    it("has no user-role in the database pointing to another tenant or to a branch without access", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM user_roles ur
        JOIN users u ON u.id = ur.user_id
        JOIN roles r ON r.id = ur.role_id
        LEFT JOIN user_branch_access a
          ON a.tenant_id = ur.tenant_id AND a.user_id = ur.user_id AND a.branch_id = ur.branch_id
        WHERE u.tenant_id <> ur.tenant_id OR r.tenant_id <> ur.tenant_id
           OR (ur.branch_id IS NOT NULL AND a.id IS NULL)`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("cardinality", () => {
    it("lets one user have several roles", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      await assign(org.tenantId, org.user.id, org.manager.id);
      await assign(org.tenantId, org.user.id, org.attendant.id, org.branchA.id);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: org.user.id }, include: { roles: true } });
      expect(user.roles.map((r) => r.roleId).sort()).toEqual([org.manager.id, org.attendant.id].sort());
    });

    it("lets one role be assigned to several users", async () => {
      const org = await newOrg();
      const second = await addUser(org.tenantId, "1002");
      await assign(org.tenantId, org.user.id, org.manager.id);
      await assign(org.tenantId, second.id, org.manager.id);

      const role = await prisma.role.findUniqueOrThrow({ where: { id: org.manager.id }, include: { userRoles: true } });
      expect(role.userRoles.map((r) => r.userId).sort()).toEqual([org.user.id, second.id].sort());
    });

    it("supports MANAGER in branch A and ATTENDANT in branch B for the same user", async () => {
      const org = await newOrg();
      await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      await grantAccess(org.tenantId, org.user.id, org.branchB.id);
      await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);
      await assign(org.tenantId, org.user.id, org.attendant.id, org.branchB.id);

      const rows = await prisma.userRole.findMany({ where: { userId: org.user.id }, include: { role: true } });
      expect(Object.fromEntries(rows.map((r) => [r.branchId, r.role.code]))).toEqual({
        [org.branchA.id]: "MANAGER",
        [org.branchB.id]: "ATTENDANT",
      });
    });

    it("keeps two tenants using the same role codes independent", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await assign(a.tenantId, a.user.id, a.manager.id);
      await assign(b.tenantId, b.user.id, b.manager.id);

      for (const org of [a, b]) {
        const rows = await prisma.userRole.findMany({ where: { tenantId: org.tenantId }, include: { role: true } });
        expect(rows.map((r) => [r.userId, r.roleId, r.role.code])).toEqual([[org.user.id, org.manager.id, "MANAGER"]]);
      }
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a user that has a role", async () => {
      const org = await newOrg();
      await assign(org.tenantId, org.user.id, org.manager.id);

      await expect(prisma.user.delete({ where: { id: org.user.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM users WHERE id = ${org.user.id}::uuid`).rejects.toThrow(USER_FK);
    });

    it("refuses to delete a role that is assigned", async () => {
      const org = await newOrg();
      await assign(org.tenantId, org.user.id, org.manager.id);

      await expect(prisma.role.delete({ where: { id: org.manager.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM roles WHERE id = ${org.manager.id}::uuid`).rejects.toThrow(ROLE_FK);
    });

    it("refuses to delete a tenant that has a user-role", async () => {
      const org = await newOrg();
      const created = await assign(org.tenantId, org.user.id, org.manager.id);

      await expect(prisma.tenant.delete({ where: { id: org.tenantId } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${org.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.userRole.findUnique({ where: { id: created.id } })).not.toBeNull();
    });

    it("refuses to remove a branch access used by a scoped role, and allows it once the role is removed", async () => {
      const org = await newOrg();
      const access = await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      const scoped = await assign(org.tenantId, org.user.id, org.manager.id, org.branchA.id);

      await expect(prisma.userBranchAccess.delete({ where: { id: access.id } })).rejects.toThrow();
      await expect(
        prisma.$executeRaw`DELETE FROM user_branch_access WHERE id = ${access.id}::uuid`,
      ).rejects.toThrow(ACCESS_FK);

      await prisma.userRole.delete({ where: { id: scoped.id } });
      await expect(prisma.userBranchAccess.delete({ where: { id: access.id } })).resolves.toMatchObject({ id: access.id });
    });

    it("does not tie a global role to any branch access", async () => {
      const org = await newOrg();
      const access = await grantAccess(org.tenantId, org.user.id, org.branchA.id);
      await assign(org.tenantId, org.user.id, org.manager.id);

      await expect(prisma.userBranchAccess.delete({ where: { id: access.id } })).resolves.toMatchObject({ id: access.id });
    });
  });

  describe("structure", () => {
    it("persists created_at as a correct UTC instant and has no updated_at", async () => {
      const org = await newOrg();
      const created = await assign(org.tenantId, org.user.id, org.manager.id);

      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM user_roles WHERE id = ${created.id}::uuid`;
      expect(row?.createdAt).toEqual(created.createdAt);
      expect(row?.driftSeconds).toBeLessThan(5);
      expect(row?.createdUtc).toBe(created.createdAt.toISOString());

      const [updatedAt] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_roles' AND column_name = 'updated_at'`;
      expect(updatedAt?.count).toBe(0n);
    });
  });
});
