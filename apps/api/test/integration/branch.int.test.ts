import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  TenantStatus,
  type Company,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const CNPJ = "11222333000181";
const OTHER_CNPJ = "44555666000199";
const CROSS_TENANT_FK = /branches_tenant_id_company_id_fkey/;

describe("Branch (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A fresh tenant with one company. */
  async function newTenantWithCompany(name = "Tenant"): Promise<Company> {
    const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    return prisma.company.create({
      data: {
        tenantId: tenant.id,
        legalName: `${name} Ltda`,
        tradeName: name,
        cnpj: CNPJ,
        status: CompanyStatus.ACTIVE,
        timezone: "America/Sao_Paulo",
      },
    });
  }

  type BranchInput = Partial<{ code: string; name: string; cnpj: string | null; status: BranchStatus; timezone: string }>;

  function newBranch(tenantId: string, companyId: string, overrides: BranchInput = {}) {
    return prisma.branch.create({
      data: {
        tenantId,
        companyId,
        name: "Shopping Morumbi",
        code: "MORUMBI",
        status: BranchStatus.ACTIVE,
        timezone: "America/Sao_Paulo",
        ...overrides,
      },
    });
  }

  /** Raw insert bypassing Prisma validation, to exercise database constraints directly. */
  function rawInsert(values: { tenantId: string; companyId: string } & Omit<BranchInput, "status"> & { status?: string }) {
    const { tenantId, companyId, name = "Shopping Morumbi", code = "MORUMBI", cnpj = null, status = "ACTIVE" } = values;
    return prisma.$executeRaw`
      INSERT INTO branches (id, tenant_id, company_id, name, code, cnpj, status, timezone, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${companyId}::uuid, ${name}, ${code}, ${cnpj},
              ${status}::branch_status, 'America/Sao_Paulo', now())`;
  }

  describe("creation and relations", () => {
    it("creates a valid branch (Tenant A + Company A + Branch A)", async () => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id);

      expect(await prisma.branch.findUnique({ where: { id: branch.id } })).toEqual(branch);
      expect(await rawInsert({ tenantId: company.tenantId, companyId: company.id, code: "ELDORADO" })).toBe(1);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const company = await newTenantWithCompany();
      const before = Date.now();
      const branch = await newBranch(company.tenantId, company.id);
      const after = Date.now();

      expect(branch.id).toMatch(UUID_V7);
      expect(uuidV7Millis(branch.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(branch.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM branches WHERE id = ${branch.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("links the branch to its tenant (Tenant 1 -> N Branch)", async () => {
      const company = await newTenantWithCompany();
      const a = await newBranch(company.tenantId, company.id, { code: "MORUMBI" });
      const b = await newBranch(company.tenantId, company.id, { code: "TATUAPE" });

      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: company.tenantId },
        include: { branches: { orderBy: { code: "asc" } } },
      });
      expect(tenant.branches.map((x) => x.id)).toEqual([a.id, b.id]);
      expect((await prisma.branch.findUniqueOrThrow({ where: { id: a.id }, include: { tenant: true } })).tenant.id).toBe(
        company.tenantId,
      );
    });

    it("links the branch to its company (Company 1 -> N Branch)", async () => {
      const company = await newTenantWithCompany();
      const a = await newBranch(company.tenantId, company.id, { code: "MORUMBI" });
      const b = await newBranch(company.tenantId, company.id, { code: "TATUAPE" });

      const withBranches = await prisma.company.findUniqueOrThrow({
        where: { id: company.id },
        include: { branches: { orderBy: { code: "asc" } } },
      });
      expect(withBranches.branches.map((x) => x.id)).toEqual([a.id, b.id]);
      const loaded = await prisma.branch.findUniqueOrThrow({ where: { id: a.id }, include: { company: true } });
      expect(loaded.company.id).toBe(company.id);
      expect(loaded.company.tenantId).toBe(loaded.tenantId);
    });

    it("rejects a non-existent company", async () => {
      const company = await newTenantWithCompany();

      await expect(newBranch(company.tenantId, randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: company.tenantId, companyId: randomUUID() })).rejects.toThrow(CROSS_TENANT_FK);
    });

    it("rejects a non-existent tenant", async () => {
      const company = await newTenantWithCompany();

      await expect(newBranch(randomUUID(), company.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: randomUUID(), companyId: company.id })).rejects.toThrow(
        /branches_tenant_id(_company_id)?_fkey/,
      );
    });
  });

  describe("multi-tenant integrity (Tenant/Company)", () => {
    it("rejects a branch of tenant A pointing to company B of tenant B", async () => {
      const companyA = await newTenantWithCompany("A");
      const companyB = await newTenantWithCompany("B");

      await expect(newBranch(companyA.tenantId, companyB.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: companyA.tenantId, companyId: companyB.id })).rejects.toThrow(CROSS_TENANT_FK);
      expect(await prisma.branch.count({ where: { tenantId: { in: [companyA.tenantId, companyB.tenantId] } } })).toBe(0);
    });

    it("rejects moving an existing branch to a company of another tenant", async () => {
      const companyA = await newTenantWithCompany("A");
      const companyB = await newTenantWithCompany("B");
      const branch = await newBranch(companyA.tenantId, companyA.id);

      await expect(prisma.branch.update({ where: { id: branch.id }, data: { companyId: companyB.id } })).rejects.toMatchObject(
        { code: "P2003" },
      );
      await expect(
        prisma.$executeRaw`UPDATE branches SET company_id = ${companyB.id}::uuid WHERE id = ${branch.id}::uuid`,
      ).rejects.toThrow(CROSS_TENANT_FK);
    });

    it("rejects moving an existing branch to another tenant while keeping its company", async () => {
      const companyA = await newTenantWithCompany("A");
      const companyB = await newTenantWithCompany("B");
      const branch = await newBranch(companyA.tenantId, companyA.id);

      await expectTenantIdImmutable(
        prisma.branch.update({ where: { id: branch.id }, data: { tenantId: companyB.tenantId } }),
        "branches",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${companyB.tenantId}::uuid WHERE id = ${branch.id}::uuid`,
        "branches",
      );
    });

    it("rejects moving a company with branches to another tenant", async () => {
      const companyA = await newTenantWithCompany("A");
      const companyB = await newTenantWithCompany("B");
      await newBranch(companyA.tenantId, companyA.id);

      await expectTenantIdImmutable(
        prisma.company.update({ where: { id: companyA.id }, data: { tenantId: companyB.tenantId, cnpj: OTHER_CNPJ } }),
        "companies",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE companies SET tenant_id = ${companyB.tenantId}::uuid, cnpj = ${OTHER_CNPJ}
                           WHERE id = ${companyA.id}::uuid`,
        "companies",
      );
    });

    it("has no branch in the database pointing to a company of another tenant", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM branches b JOIN companies c ON c.id = b.company_id
        WHERE c.tenant_id <> b.tenant_id`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("code", () => {
    it("rejects a duplicate code in the same tenant, even in another company", async () => {
      const company = await newTenantWithCompany();
      const sibling = await prisma.company.create({
        data: {
          tenantId: company.tenantId,
          legalName: "Outra Ltda",
          tradeName: "Outra",
          cnpj: OTHER_CNPJ,
          status: CompanyStatus.ACTIVE,
          timezone: "America/Sao_Paulo",
        },
      });
      await newBranch(company.tenantId, company.id, { code: "MORUMBI" });

      await expect(newBranch(company.tenantId, company.id, { code: "MORUMBI" })).rejects.toMatchObject({ code: "P2002" });
      await expect(newBranch(company.tenantId, sibling.id, { code: "MORUMBI" })).rejects.toMatchObject({ code: "P2002" });
      await expect(rawInsert({ tenantId: company.tenantId, companyId: sibling.id, code: "MORUMBI" })).rejects.toThrow(
        /branches_tenant_id_code_key/,
      );
    });

    it("accepts the same code in different tenants", async () => {
      const companyA = await newTenantWithCompany("A");
      const companyB = await newTenantWithCompany("B");

      const a = await newBranch(companyA.tenantId, companyA.id, { code: "ELDORADO" });
      const b = await newBranch(companyB.tenantId, companyB.id, { code: "ELDORADO" });
      expect(a.code).toBe(b.code);
    });

    it("does not impose a case/format rule yet", async () => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id, { code: "loja-01 Tatuapé" });
      expect(branch.code).toBe("loja-01 Tatuapé");
    });
  });

  describe("blank names and codes", () => {
    it.each([
      ["name", ""],
      ["name", "   "],
      ["code", ""],
      ["code", "   "],
    ])("rejects %s = %j", async (column, value) => {
      const company = await newTenantWithCompany();
      const constraint = column === "name" ? "branches_name_check" : "branches_code_check";

      await expect(rawInsert({ tenantId: company.tenantId, companyId: company.id, [column]: value })).rejects.toThrow(
        constraint,
      );
      await expect(newBranch(company.tenantId, company.id, { [column]: value })).rejects.toThrow(constraint);
    });
  });

  describe("cnpj", () => {
    it("accepts a null CNPJ", async () => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id, { cnpj: null });

      expect(branch.cnpj).toBeNull();
      const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
        SELECT cnpj IS NULL AS "isNull" FROM branches WHERE id = ${branch.id}::uuid`;
      expect(row?.isNull).toBe(true);
    });

    it("accepts many branches with a null CNPJ in the same tenant", async () => {
      const company = await newTenantWithCompany();
      for (const code of ["MORUMBI", "ELDORADO", "TATUAPE"]) await newBranch(company.tenantId, company.id, { code });
      await rawInsert({ tenantId: company.tenantId, companyId: company.id, code: "IBIRAPUERA", cnpj: null });

      expect(await prisma.branch.count({ where: { tenantId: company.tenantId, cnpj: null } })).toBe(4);
    });

    it("persists a valid CNPJ", async () => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id, { cnpj: "00123456000270" });

      const [row] = await prisma.$queryRaw<{ cnpj: string }[]>`SELECT cnpj FROM branches WHERE id = ${branch.id}::uuid`;
      expect(row?.cnpj).toBe("00123456000270");
    });

    it.each([
      ["empty", ""],
      ["with punctuation", "11.222.333/0002-62"],
      ["with letters", "1122233300026A"],
      ["with spaces", "11222333 00262"],
      ["too short", "1122233300026"],
      ["too long", "112223330002621"],
      ["with non-ASCII digits", "١١٢٢٢٣٣٣٠٠٠٢٦٢"],
    ])("rejects a CNPJ %s", async (_, cnpj) => {
      const company = await newTenantWithCompany();

      await expect(rawInsert({ tenantId: company.tenantId, companyId: company.id, cnpj })).rejects.toThrow(
        /branches_cnpj_check/,
      );
      await expect(newBranch(company.tenantId, company.id, { cnpj })).rejects.toThrow(/branches_cnpj_check/);
    });

    it("rejects a duplicate filled CNPJ in the same tenant", async () => {
      const company = await newTenantWithCompany();
      await newBranch(company.tenantId, company.id, { code: "MORUMBI", cnpj: "00123456000270" });

      await expect(
        newBranch(company.tenantId, company.id, { code: "ELDORADO", cnpj: "00123456000270" }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        rawInsert({ tenantId: company.tenantId, companyId: company.id, code: "ELDORADO", cnpj: "00123456000270" }),
      ).rejects.toThrow(/branches_tenant_id_cnpj_key/);
    });

    it("accepts the same CNPJ in different tenants", async () => {
      const companyA = await newTenantWithCompany("A");
      const companyB = await newTenantWithCompany("B");

      const a = await newBranch(companyA.tenantId, companyA.id, { cnpj: "00123456000270" });
      const b = await newBranch(companyB.tenantId, companyB.id, { cnpj: "00123456000270" });
      expect(a.cnpj).toBe(b.cnpj);
    });
  });

  describe("status, timezone and timestamps", () => {
    it.each(Object.values(BranchStatus))("persists status %s", async (status) => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id, { status });

      const [row] = await prisma.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM branches WHERE id = ${branch.id}::uuid`;
      expect(row?.status).toBe(status);
    });

    it("only knows ACTIVE and INACTIVE", () => {
      expect(Object.values(BranchStatus)).toEqual(["ACTIVE", "INACTIVE"]);
    });

    it("rejects an invalid status", async () => {
      const company = await newTenantWithCompany();

      for (const invalid of ["DELETED", "TRIAL", "active", ""]) {
        await expect(rawInsert({ tenantId: company.tenantId, companyId: company.id, status: invalid })).rejects.toThrow(
          /invalid input value for enum branch_status/,
        );
      }
      await expect(newBranch(company.tenantId, company.id, { status: "DELETED" as BranchStatus })).rejects.toThrow();
      expect(await prisma.branch.count({ where: { tenantId: company.tenantId } })).toBe(0);
    });

    it("persists the timezone", async () => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id, { timezone: "America/Manaus" });

      const [row] = await prisma.$queryRaw<{ timezone: string }[]>`
        SELECT timezone FROM branches WHERE id = ${branch.id}::uuid`;
      expect(row?.timezone).toBe("America/Manaus");
    });

    it("stores created_at/updated_at as correct UTC instants", async () => {
      const skewMs = 5_000; // tolerance between test-runner and database clocks
      const company = await newTenantWithCompany();
      const before = Date.now();
      const branch = await newBranch(company.tenantId, company.id);

      expect(branch.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
      expect(branch.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + skewMs);

      // Compared with the database clock: a session time-zone shift would show up as hours of drift.
      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM branches WHERE id = ${branch.id}::uuid`;
      expect(row?.createdAt).toEqual(branch.createdAt);
      expect(row?.driftSeconds).toBeLessThan(skewMs / 1000);
      expect(row?.createdUtc).toBe(branch.createdAt.toISOString());
    });

    it("refreshes updated_at on update and keeps created_at", async () => {
      const company = await newTenantWithCompany();
      const branch = await newBranch(company.tenantId, company.id);
      await new Promise((r) => setTimeout(r, 20));

      const updated = await prisma.branch.update({ where: { id: branch.id }, data: { status: BranchStatus.INACTIVE } });

      expect(updated.createdAt).toEqual(branch.createdAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(branch.updatedAt.getTime());
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a company that has a branch", async () => {
      const company = await newTenantWithCompany();
      await newBranch(company.tenantId, company.id);

      await expect(prisma.company.delete({ where: { id: company.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM companies WHERE id = ${company.id}::uuid`).rejects.toThrow(
        CROSS_TENANT_FK,
      );
      expect(await prisma.company.findUnique({ where: { id: company.id } })).not.toBeNull();
      expect(await prisma.branch.count({ where: { companyId: company.id } })).toBe(1);
    });

    it("refuses to delete a tenant that has a branch", async () => {
      const company = await newTenantWithCompany();
      await newBranch(company.tenantId, company.id);

      await expect(prisma.tenant.delete({ where: { id: company.tenantId } })).rejects.toThrow();
      // Both companies_tenant_id_fkey and branches_tenant_id_fkey (RESTRICT) protect this row.
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${company.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.tenant.findUnique({ where: { id: company.tenantId } })).not.toBeNull();
      expect(await prisma.branch.count({ where: { tenantId: company.tenantId } })).toBe(1);
    });
  });
});
