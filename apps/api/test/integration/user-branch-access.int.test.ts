import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  TenantStatus,
  UserStatus,
  type Branch,
  type PrismaClient,
  type User,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const USER_FK = /user_branch_access_tenant_id_user_id_fkey/;
const BRANCH_FK = /user_branch_access_tenant_id_branch_id_fkey/;
const CROSS_TENANT_FK = /user_branch_access_tenant_id_(user|branch)_id_fkey/;

interface Org {
  tenantId: string;
  companyId: string;
  branch: Branch;
  user: User;
}

describe("UserBranchAccess (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant with one company, one branch and one user. */
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
    const org = { tenantId: tenant.id, companyId: company.id } as Org;
    org.branch = await addBranch(org, "MORUMBI");
    org.user = await addUser(org, "1001");
    return org;
  }

  function addBranch(org: Pick<Org, "tenantId" | "companyId">, code: string) {
    return prisma.branch.create({
      data: {
        tenantId: org.tenantId,
        companyId: org.companyId,
        name: `Filial ${code}`,
        code,
        status: BranchStatus.ACTIVE,
        timezone: "America/Sao_Paulo",
      },
    });
  }

  function addUser(org: Pick<Org, "tenantId">, employeeNumber: string) {
    return prisma.user.create({
      data: { tenantId: org.tenantId, name: `Usuário ${employeeNumber}`, employeeNumber, passwordHash: "hash", status: UserStatus.ACTIVE },
    });
  }

  function grant(tenantId: string, userId: string, branchId: string) {
    return prisma.userBranchAccess.create({ data: { tenantId, userId, branchId } });
  }

  function rawGrant(tenantId: string, userId: string, branchId: string) {
    return prisma.$executeRaw`
      INSERT INTO user_branch_access (id, tenant_id, user_id, branch_id)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${userId}::uuid, ${branchId}::uuid)`;
  }

  describe("creation", () => {
    it("creates a valid User <-> Branch access", async () => {
      const org = await newOrg();
      const access = await grant(org.tenantId, org.user.id, org.branch.id);

      expect(await prisma.userBranchAccess.findUnique({ where: { id: access.id } })).toEqual(access);
      const loaded = await prisma.userBranchAccess.findUniqueOrThrow({
        where: { id: access.id },
        include: { user: true, branch: true, tenant: true },
      });
      expect([loaded.user.id, loaded.branch.id, loaded.tenant.id]).toEqual([org.user.id, org.branch.id, org.tenantId]);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const org = await newOrg();
      const before = Date.now();
      const access = await grant(org.tenantId, org.user.id, org.branch.id);
      const after = Date.now();

      expect(access.id).toMatch(UUID_V7);
      expect(uuidV7Millis(access.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(access.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM user_branch_access WHERE id = ${access.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("persists tenant_id and created_at (UTC) correctly", async () => {
      const org = await newOrg();
      const access = await grant(org.tenantId, org.user.id, org.branch.id);

      const [row] = await prisma.$queryRaw<{ tenantId: string; createdAt: Date; driftSeconds: number }[]>`
        SELECT tenant_id::text AS "tenantId", created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds"
        FROM user_branch_access WHERE id = ${access.id}::uuid`;
      expect(row?.tenantId).toBe(org.tenantId);
      expect(row?.createdAt).toEqual(access.createdAt);
      expect(row?.driftSeconds).toBeLessThan(5);
    });

    it("rejects a non-existent user", async () => {
      const org = await newOrg();

      await expect(grant(org.tenantId, randomUUID(), org.branch.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawGrant(org.tenantId, randomUUID(), org.branch.id)).rejects.toThrow(USER_FK);
    });

    it("rejects a non-existent branch", async () => {
      const org = await newOrg();

      await expect(grant(org.tenantId, org.user.id, randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawGrant(org.tenantId, org.user.id, randomUUID())).rejects.toThrow(BRANCH_FK);
    });

    it("rejects a non-existent tenant", async () => {
      const org = await newOrg();

      await expect(grant(randomUUID(), org.user.id, org.branch.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawGrant(randomUUID(), org.user.id, org.branch.id)).rejects.toThrow(
        /user_branch_access_tenant_id(_user_id|_branch_id)?_fkey/,
      );
    });
  });

  describe("multi-tenant isolation", () => {
    it("rejects a user of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(grant(a.tenantId, b.user.id, a.branch.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawGrant(a.tenantId, b.user.id, a.branch.id)).rejects.toThrow(USER_FK);
    });

    it("rejects a branch of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(grant(a.tenantId, a.user.id, b.branch.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawGrant(a.tenantId, a.user.id, b.branch.id)).rejects.toThrow(BRANCH_FK);
    });

    it("rejects a user of tenant A with a branch of tenant B, whatever tenant_id is used", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      for (const tenantId of [a.tenantId, b.tenantId]) {
        await expect(grant(tenantId, a.user.id, b.branch.id)).rejects.toMatchObject({ code: "P2003" });
        await expect(rawGrant(tenantId, a.user.id, b.branch.id)).rejects.toThrow(CROSS_TENANT_FK);
      }
      expect(await prisma.userBranchAccess.count({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } })).toBe(0);
    });

    it("does not interfere across tenants with identical structures", async () => {
      // Same employee number and branch code in both tenants.
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grant(a.tenantId, a.user.id, a.branch.id);
      await grant(b.tenantId, b.user.id, b.branch.id);

      for (const org of [a, b]) {
        const accesses = await prisma.userBranchAccess.findMany({ where: { tenantId: org.tenantId } });
        expect(accesses.map((x) => [x.userId, x.branchId])).toEqual([[org.user.id, org.branch.id]]);
      }
    });

    it("rejects changing user_id to a user of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const access = await grant(a.tenantId, a.user.id, a.branch.id);

      await expect(
        prisma.userBranchAccess.update({ where: { id: access.id }, data: { userId: b.user.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE user_branch_access SET user_id = ${b.user.id}::uuid WHERE id = ${access.id}::uuid`,
      ).rejects.toThrow(USER_FK);
    });

    it("rejects changing branch_id to a branch of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const access = await grant(a.tenantId, a.user.id, a.branch.id);

      await expect(
        prisma.userBranchAccess.update({ where: { id: access.id }, data: { branchId: b.branch.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE user_branch_access SET branch_id = ${b.branch.id}::uuid WHERE id = ${access.id}::uuid`,
      ).rejects.toThrow(BRANCH_FK);
    });

    it("rejects changing only tenant_id (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const access = await grant(a.tenantId, a.user.id, a.branch.id);

      await expect(
        prisma.userBranchAccess.update({ where: { id: access.id }, data: { tenantId: b.tenantId } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE user_branch_access SET tenant_id = ${b.tenantId}::uuid WHERE id = ${access.id}::uuid`,
      ).rejects.toThrow(CROSS_TENANT_FK);
    });

    it("blocks moving a user or a branch that has accesses to another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await grant(a.tenantId, a.user.id, a.branch.id);

      await expect(
        prisma.$executeRaw`UPDATE users SET tenant_id = ${b.tenantId}::uuid, employee_number = 'X-1'
                           WHERE id = ${a.user.id}::uuid`,
      ).rejects.toThrow(USER_FK);
      await expect(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${b.tenantId}::uuid, company_id = ${b.companyId}::uuid,
                                               code = 'X-1'
                           WHERE id = ${a.branch.id}::uuid`,
      ).rejects.toThrow(BRANCH_FK);
    });

    // tenant_id is conceptually immutable; the schema cannot forbid a fully consistent move.
    it("GAP (M1.14): accepts moving an access when tenant_id, user_id and branch_id change together", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const access = await grant(a.tenantId, a.user.id, a.branch.id);

      const moved = await prisma.userBranchAccess.update({
        where: { id: access.id },
        data: { tenantId: b.tenantId, userId: b.user.id, branchId: b.branch.id },
      });

      expect(moved).toMatchObject({ tenantId: b.tenantId, userId: b.user.id, branchId: b.branch.id });
    });

    it("has no access in the database whose user or branch belongs to another tenant", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM user_branch_access a
        JOIN users u ON u.id = a.user_id
        JOIN branches b ON b.id = a.branch_id
        WHERE u.tenant_id <> a.tenant_id OR b.tenant_id <> a.tenant_id`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("uniqueness and cardinality", () => {
    it("rejects a duplicate access (Prisma and SQL)", async () => {
      const org = await newOrg();
      await grant(org.tenantId, org.user.id, org.branch.id);

      await expect(grant(org.tenantId, org.user.id, org.branch.id)).rejects.toMatchObject({ code: "P2002" });
      await expect(rawGrant(org.tenantId, org.user.id, org.branch.id)).rejects.toThrow(
        /user_branch_access_tenant_id_user_id_branch_id_key/,
      );
    });

    it("lets one user access several branches of the same tenant", async () => {
      const org = await newOrg();
      const eldorado = await addBranch(org, "ELDORADO");
      const tatuape = await addBranch(org, "TATUAPE");
      for (const branch of [org.branch, eldorado, tatuape]) await grant(org.tenantId, org.user.id, branch.id);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: org.user.id },
        include: { branchAccesses: true },
      });
      expect(user.branchAccesses.map((x) => x.branchId).sort()).toEqual([org.branch.id, eldorado.id, tatuape.id].sort());
    });

    it("lets one branch be accessed by several users", async () => {
      const org = await newOrg();
      const second = await addUser(org, "1002");
      const third = await addUser(org, "1003");
      for (const user of [org.user, second, third]) await grant(org.tenantId, user.id, org.branch.id);

      const branch = await prisma.branch.findUniqueOrThrow({
        where: { id: org.branch.id },
        include: { userAccesses: true },
      });
      expect(branch.userAccesses.map((x) => x.userId).sort()).toEqual([org.user.id, second.id, third.id].sort());
    });

    it("allows a user with no branch access (0..N)", async () => {
      const org = await newOrg();

      expect(await prisma.userBranchAccess.count({ where: { userId: org.user.id } })).toBe(0);
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a user that has an access", async () => {
      const org = await newOrg();
      await grant(org.tenantId, org.user.id, org.branch.id);

      await expect(prisma.user.delete({ where: { id: org.user.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM users WHERE id = ${org.user.id}::uuid`).rejects.toThrow(USER_FK);
      expect(await prisma.user.findUnique({ where: { id: org.user.id } })).not.toBeNull();
    });

    it("refuses to delete a branch that has an access", async () => {
      const org = await newOrg();
      await grant(org.tenantId, org.user.id, org.branch.id);

      await expect(prisma.branch.delete({ where: { id: org.branch.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM branches WHERE id = ${org.branch.id}::uuid`).rejects.toThrow(BRANCH_FK);
      expect(await prisma.branch.findUnique({ where: { id: org.branch.id } })).not.toBeNull();
    });

    it("refuses to delete a tenant that has an access", async () => {
      const org = await newOrg();
      const access = await grant(org.tenantId, org.user.id, org.branch.id);

      await expect(prisma.tenant.delete({ where: { id: org.tenantId } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${org.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.userBranchAccess.findUnique({ where: { id: access.id } })).not.toBeNull();
    });
  });
});
