import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CompanyStatus, TenantStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { CompanyRepository, type NewCompany } from "../../src/companies/company.repository.js";
import { PermissionRepository } from "../../src/permissions/permission.repository.js";
import { TenantContextMissingError, TenantContextService } from "../../src/tenancy/tenant-context.js";
import { MODEL_SCOPE, TenantScope } from "../../src/tenancy/tenant-scope.js";
import { MODEL_TABLES, classifyTable } from "./table-audit.js";

// M2.1: application-level tenant isolation (TenantContext + TenantScope), logged in as the runtime role erp_app.
// Without RLS the database lets erp_app read every tenant; these tests prove the application layer does not.

function newCompany(tradeName: string): NewCompany {
  return { legalName: `${tradeName} Ltda`, tradeName, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" };
}

describe("tenant context and tenant-scoped data access (PostgreSQL, as erp_app)", () => {
  const tenants = new TenantContextService();
  const scope = new TenantScope(tenants);
  let app: PrismaClient;
  let owner: PrismaClient;
  let companies: CompanyRepository;
  let tenantA: string;
  let tenantB: string;

  /** Companies of a tenant read with the owner identity, bypassing the application layer (ground truth). */
  async function rowsOf(tenantId: string) {
    return owner.company.findMany({ where: { tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  }

  beforeAll(async () => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    companies = new CompanyRepository(app, scope);
    // Root operation: Tenant has no tenant_id and is never scoped.
    tenantA = (await app.tenant.create({ data: { name: "Ctx A", status: TenantStatus.ACTIVE } })).id;
    tenantB = (await app.tenant.create({ data: { name: "Ctx B", status: TenantStatus.ACTIVE } })).id;
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  it("classifies every model exactly like the M1 table audit (root, global, tenant)", () => {
    expect(Object.keys(MODEL_SCOPE).sort()).toEqual(Object.keys(MODEL_TABLES).sort());
    for (const [model, table] of Object.entries(MODEL_TABLES)) {
      expect(MODEL_SCOPE[model as keyof typeof MODEL_SCOPE], model).toBe(classifyTable(table));
    }
  });

  describe("Company repository, tenant A x tenant B", () => {
    let a1: string;
    let a2: string;
    let b1: string;

    beforeAll(async () => {
      a1 = (await tenants.run({ tenantId: tenantA }, () => companies.create(newCompany("A1")))).id;
      a2 = (await tenants.run({ tenantId: tenantA }, () => companies.create({ ...newCompany("A2"), cnpj: "11222333000262" }))).id;
      b1 = (await tenants.run({ tenantId: tenantB }, () => companies.create(newCompany("B1")))).id;
    });

    it("create stores the context tenant (10)", async () => {
      expect((await owner.company.findUniqueOrThrow({ where: { id: a1 } })).tenantId).toBe(tenantA);
      expect((await owner.company.findUniqueOrThrow({ where: { id: b1 } })).tenantId).toBe(tenantB);
    });

    it("create ignores a tenantId smuggled into the input", async () => {
      const smuggled = { ...newCompany("Smuggled"), cnpj: "11222333000343", tenantId: tenantB } as NewCompany;
      const created = await tenants.run({ tenantId: tenantA }, () => companies.create(smuggled));
      expect(created.tenantId).toBe(tenantA);
      expect((await owner.company.findUniqueOrThrow({ where: { id: created.id } })).tenantId).toBe(tenantA);
    });

    it("list returns only the current tenant (8)", async () => {
      const inA = await tenants.run({ tenantId: tenantA }, () => companies.list());
      const inB = await tenants.run({ tenantId: tenantB }, () => companies.list());
      expect(inA.map((c) => c.id)).toEqual((await rowsOf(tenantA)).map((c) => c.id));
      expect(inA.map((c) => c.id)).toEqual(expect.arrayContaining([a1, a2]));
      expect(inA.every((c) => c.tenantId === tenantA)).toBe(true);
      expect(inB.map((c) => c.id)).toEqual([b1]);
    });

    it("findById finds its own tenant's company and returns null for the other tenant's id (9)", async () => {
      expect((await tenants.run({ tenantId: tenantA }, () => companies.findById(a1)))?.id).toBe(a1);
      expect(await tenants.run({ tenantId: tenantA }, () => companies.findById(b1))).toBeNull();
      expect((await tenants.run({ tenantId: tenantB }, () => companies.findById(b1)))?.id).toBe(b1);
      expect(await tenants.run({ tenantId: tenantB }, () => companies.findById(a1))).toBeNull();
      expect(await tenants.run({ tenantId: tenantA }, () => companies.findById(randomUUID()))).toBeNull();
    });

    it("update changes its own tenant's company and never crosses tenants (11)", async () => {
      const before = await owner.company.findUniqueOrThrow({ where: { id: b1 } });

      expect(await tenants.run({ tenantId: tenantA }, () => companies.update(b1, { tradeName: "Hijacked" }))).toBeNull();
      expect(await owner.company.findUniqueOrThrow({ where: { id: b1 } })).toEqual(before);

      const updated = await tenants.run({ tenantId: tenantB }, () => companies.update(b1, { tradeName: "B1 novo", status: CompanyStatus.INACTIVE }));
      expect(updated).toMatchObject({ id: b1, tenantId: tenantB, tradeName: "B1 novo", status: CompanyStatus.INACTIVE });
      expect(await tenants.run({ tenantId: tenantB }, () => companies.update(a1, { tradeName: "Hijacked" }))).toBeNull();
      expect((await owner.company.findUniqueOrThrow({ where: { id: a1 } })).tradeName).toBe("A1");
    });

    it("fails before touching the database when there is no context (2)", async () => {
      const count = await owner.company.count();
      await expect(companies.create(newCompany("NoCtx"))).rejects.toThrow(TenantContextMissingError);
      await expect(companies.list()).rejects.toThrow(TenantContextMissingError);
      await expect(companies.findById(a1)).rejects.toThrow(TenantContextMissingError);
      await expect(companies.update(a1, { tradeName: "x" })).rejects.toThrow(TenantContextMissingError);
      expect(await owner.company.count()).toBe(count);
    });

    it("keeps concurrent A and B requests apart while they hit the database (3)", async () => {
      const request = (tenantId: string, delays: number[]) =>
        tenants.run({ tenantId }, async () => {
          const seen: string[][] = [];
          for (const ms of delays) {
            await sleep(ms);
            seen.push((await companies.list()).map((c) => c.tenantId));
            seen.push([tenants.requireTenantId()]);
          }
          return seen.flat();
        });

      const results = await Promise.all([
        request(tenantA, [3, 0, 2, 1]),
        request(tenantB, [0, 3, 1, 2]),
        request(tenantA, [1, 2, 0, 3]),
        request(tenantB, [2, 1, 3, 0]),
      ]);
      expect(new Set(results[0])).toEqual(new Set([tenantA]));
      expect(new Set(results[1])).toEqual(new Set([tenantB]));
      expect(new Set(results[2])).toEqual(new Set([tenantA]));
      expect(new Set(results[3])).toEqual(new Set([tenantB]));
      expect(tenants.current()).toBeUndefined();
    });
  });

  describe("transactions (7)", () => {
    it("keeps the tenant inside an interactive transaction and its awaits", async () => {
      const result = await tenants.run({ tenantId: tenantA }, () =>
        app.$transaction(async (tx) => {
          const repo = new CompanyRepository(tx, scope);
          const created = await repo.create({ ...newCompany("Tx"), cnpj: "11222333000424" });
          await sleep(2);
          return { tenant: tenants.requireTenantId(), created, visible: (await repo.list()).some((c) => c.id === created.id) };
        }),
      );
      expect(result.tenant).toBe(tenantA);
      expect(result.created.tenantId).toBe(tenantA);
      expect(result.visible).toBe(true);
      expect(tenants.current()).toBeUndefined();
    });

    it("runs concurrent transactions of A and B without mixing tenants, and rolls back with the context intact", async () => {
      const tx = (tenantId: string, cnpj: string) =>
        tenants.run({ tenantId }, () =>
          app
            .$transaction(async (client) => {
              const repo = new CompanyRepository(client, scope);
              const created = await repo.create({ ...newCompany("Rollback"), cnpj });
              await sleep(tenantId === tenantA ? 3 : 1);
              const seen = (await repo.list()).map((c) => c.tenantId);
              throw Object.assign(new Error("rollback"), { seen, created, tenant: tenants.requireTenantId() });
            })
            .catch((error: { seen: string[]; created: { id: string; tenantId: string }; tenant: string }) => error),
        );

      const [a, b] = await Promise.all([tx(tenantA, "11222333000505"), tx(tenantB, "11222333000505")]);
      expect(a.tenant).toBe(tenantA);
      expect(new Set(a.seen)).toEqual(new Set([tenantA]));
      expect(a.created.tenantId).toBe(tenantA);
      expect(b.tenant).toBe(tenantB);
      expect(new Set(b.seen)).toEqual(new Set([tenantB]));
      expect(await owner.company.count({ where: { id: { in: [a.created.id, b.created.id] } } })).toBe(0);
    });
  });

  describe("global and root data (12)", () => {
    it("reads the global Permission catalog without any tenant context", async () => {
      const module = `c${randomUUID().slice(0, 8)}`;
      const permission = await owner.permission.create({ data: { code: `${module}.read`, module, description: "Ctx" } });
      const permissions = new PermissionRepository(app);

      expect(tenants.current()).toBeUndefined();
      expect(await permissions.findByCode(permission.code)).toMatchObject({ id: permission.id });
      expect((await permissions.list()).map((p) => p.code)).toContain(permission.code);
      expect(await tenants.run({ tenantId: tenantA }, () => permissions.findByCode(permission.code))).toMatchObject({ id: permission.id });
    });

    it("never scopes Tenant (root) by the context", async () => {
      const both = await tenants.run({ tenantId: tenantA }, () => app.tenant.findMany({ where: { id: { in: [tenantA, tenantB] } } }));
      expect(both).toHaveLength(2);
    });
  });
});
