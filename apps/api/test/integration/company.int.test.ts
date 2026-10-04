import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CompanyStatus, TenantStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const CNPJ = "11222333000181";

describe("Company (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function newTenant(name = "Tenant") {
    return prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
  }

  async function newCompany(tenantId: string, overrides: Partial<{ cnpj: string; status: CompanyStatus }> = {}) {
    return prisma.company.create({
      data: {
        tenantId,
        legalName: "Empresa Ltda",
        tradeName: "Empresa",
        cnpj: CNPJ,
        status: CompanyStatus.ACTIVE,
        timezone: "America/Sao_Paulo",
        ...overrides,
      },
    });
  }

  /** Raw insert bypassing Prisma validation, to exercise database constraints directly. */
  function rawInsert(values: { tenantId: string | null; legalName?: string; tradeName?: string; cnpj?: string; status?: string }) {
    const { tenantId, legalName = "Empresa Ltda", tradeName = "Empresa", cnpj = CNPJ, status = "ACTIVE" } = values;
    return prisma.$executeRaw`
      INSERT INTO companies (id, tenant_id, legal_name, trade_name, cnpj, status, timezone, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${legalName}, ${tradeName}, ${cnpj}, ${status}::company_status,
              'America/Sao_Paulo', now())`;
  }

  it("creates a valid company", async () => {
    const tenant = await newTenant();
    const company = await newCompany(tenant.id);

    expect(await prisma.company.findUnique({ where: { id: company.id } })).toEqual(company);
  });

  it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
    const tenant = await newTenant();
    const before = Date.now();
    const company = await newCompany(tenant.id);
    const after = Date.now();

    expect(company.id).toMatch(UUID_V7);
    expect(uuidV7Millis(company.id)).toBeGreaterThanOrEqual(before);
    expect(uuidV7Millis(company.id)).toBeLessThanOrEqual(after);
    const [row] = await prisma.$queryRaw<{ type: string }[]>`
      SELECT pg_typeof(id)::text AS type FROM companies WHERE id = ${company.id}::uuid`;
    expect(row?.type).toBe("uuid");
  });

  it("links the company to its tenant (Tenant 1 -> N Company)", async () => {
    const tenant = await newTenant();
    const first = await newCompany(tenant.id, { cnpj: "11222333000181" });
    const second = await newCompany(tenant.id, { cnpj: "44555666000199" });

    expect(first.tenantId).toBe(tenant.id);
    const withCompanies = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      include: { companies: { orderBy: { cnpj: "asc" } } },
    });
    expect(withCompanies.companies.map((c) => c.id)).toEqual([first.id, second.id]);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: first.id }, include: { tenant: true } })).tenant.id).toBe(
      tenant.id,
    );
  });

  it("rejects a non-existent tenant", async () => {
    await expect(newCompany(randomUUID())).rejects.toMatchObject({ code: "P2003" });
    await expect(rawInsert({ tenantId: randomUUID() })).rejects.toThrow(/companies_tenant_id_fkey/);
  });

  it("rejects a company without tenant", async () => {
    await expect(rawInsert({ tenantId: null })).rejects.toThrow(/null value in column "tenant_id"/);
  });

  it("rejects a duplicate CNPJ in the same tenant", async () => {
    const tenant = await newTenant();
    await newCompany(tenant.id);

    await expect(newCompany(tenant.id)).rejects.toMatchObject({ code: "P2002" });
    await expect(rawInsert({ tenantId: tenant.id })).rejects.toThrow(/companies_tenant_id_cnpj_key/);
  });

  it("accepts the same CNPJ in different tenants", async () => {
    const a = await newCompany((await newTenant("A")).id);
    const b = await newCompany((await newTenant("B")).id);

    expect(a.cnpj).toBe(b.cnpj);
    expect(a.tenantId).not.toBe(b.tenantId);
  });

  it("persists legal_name, trade_name, cnpj and timezone exactly", async () => {
    const tenant = await newTenant();
    const company = await prisma.company.create({
      data: {
        tenantId: tenant.id,
        legalName: "Açaí & Sucos São João Comércio de Alimentos Ltda.",
        tradeName: "Açaí São João — Piso 2",
        cnpj: "00123456000100",
        status: CompanyStatus.ACTIVE,
        timezone: "America/Manaus",
      },
    });

    const [row] = await prisma.$queryRaw<{ legalName: string; tradeName: string; cnpj: string; timezone: string }[]>`
      SELECT legal_name AS "legalName", trade_name AS "tradeName", cnpj, timezone
      FROM companies WHERE id = ${company.id}::uuid`;
    expect(row).toEqual({
      legalName: "Açaí & Sucos São João Comércio de Alimentos Ltda.",
      tradeName: "Açaí São João — Piso 2",
      cnpj: "00123456000100",
      timezone: "America/Manaus",
    });
  });

  it.each(Object.values(CompanyStatus))("persists status %s", async (status) => {
    const company = await newCompany((await newTenant()).id, { status });

    const [row] = await prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM companies WHERE id = ${company.id}::uuid`;
    expect(row?.status).toBe(status);
  });

  it("only knows ACTIVE and INACTIVE", () => {
    expect(Object.values(CompanyStatus)).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("rejects an invalid status", async () => {
    const tenant = await newTenant();

    for (const invalid of ["DELETED", "TRIAL", "active", ""]) {
      await expect(rawInsert({ tenantId: tenant.id, status: invalid })).rejects.toThrow(
        /invalid input value for enum company_status/,
      );
    }
    await expect(newCompany(tenant.id, { status: "DELETED" as CompanyStatus })).rejects.toThrow();
    expect(await prisma.company.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it.each([
    ["empty", ""],
    ["with punctuation", "11.222.333/0001-81"],
    ["with letters", "1122233300018A"],
    ["with spaces", "11222333 00181"],
    ["too short", "1122233300018"],
    ["too long", "112223330001811"],
    ["with non-ASCII digits", "١١٢٢٢٣٣٣٠٠٠١٨١"],
  ])("rejects a CNPJ %s", async (_, cnpj) => {
    const tenant = await newTenant();

    await expect(rawInsert({ tenantId: tenant.id, cnpj })).rejects.toThrow(/companies_cnpj_check/);
    await expect(newCompany(tenant.id, { cnpj })).rejects.toThrow(/companies_cnpj_check/);
  });

  it.each([
    ["legal_name", "", "companies_legal_name_check"],
    ["legal_name", "   ", "companies_legal_name_check"],
    ["trade_name", "", "companies_trade_name_check"],
    ["trade_name", "   ", "companies_trade_name_check"],
  ])("rejects an empty %s (%j)", async (column, value, constraint) => {
    const tenant = await newTenant();
    const values = column === "legal_name" ? { legalName: value } : { tradeName: value };

    await expect(rawInsert({ tenantId: tenant.id, ...values })).rejects.toThrow(constraint);
  });

  it("stores created_at/updated_at as correct UTC instants", async () => {
    const skewMs = 5_000; // tolerance between test-runner and database clocks
    const before = Date.now();
    const company = await newCompany((await newTenant()).id);

    expect(company.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
    expect(company.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + skewMs);

    // Compared with the database clock: a session time-zone shift would show up as hours of drift.
    const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
      SELECT created_at AS "createdAt",
             abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
      FROM companies WHERE id = ${company.id}::uuid`;
    expect(row?.createdAt).toEqual(company.createdAt);
    expect(row?.driftSeconds).toBeLessThan(skewMs / 1000);
    expect(row?.createdUtc).toBe(company.createdAt.toISOString());
  });

  it("refreshes updated_at on update and keeps created_at", async () => {
    const company = await newCompany((await newTenant()).id);
    await new Promise((r) => setTimeout(r, 20));

    const updated = await prisma.company.update({ where: { id: company.id }, data: { status: CompanyStatus.INACTIVE } });

    expect(updated.createdAt).toEqual(company.createdAt);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(company.updatedAt.getTime());
  });

  it("refuses to physically delete a tenant that has a company", async () => {
    const tenant = await newTenant();
    await newCompany(tenant.id);

    await expect(prisma.tenant.delete({ where: { id: tenant.id } })).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenant.id}::uuid`).rejects.toThrow(
      /companies_tenant_id_fkey/,
    );
    expect(await prisma.tenant.findUnique({ where: { id: tenant.id } })).not.toBeNull();
    expect(await prisma.company.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("refuses to change the id of a tenant that has a company", async () => {
    const tenant = await newTenant();
    await newCompany(tenant.id);

    await expect(
      prisma.$executeRaw`UPDATE tenants SET id = ${randomUUID()}::uuid WHERE id = ${tenant.id}::uuid`,
    ).rejects.toThrow(/companies_tenant_id_fkey/);
  });
});
