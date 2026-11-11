import { randomBytes } from "node:crypto";
import type { MeDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BranchStatus, ProductStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { DEMO_BRANCHES, DEMO_PRODUCTS, DEMO_USERS, seedDevData, type DevSeedSummary } from "../../src/database/seed/dev.js";
import { DEFAULT_ROLE_PERMISSIONS } from "../../src/tenants/default-roles.js";
import { containsSecret, ensurePermissionCatalog, testAuthConfig } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

const ORIGIN = "http://localhost:3000";
// Random per run, like every test credential; satisfies the password policy (>= 8 characters).
const PASSWORD = `Demo-${randomBytes(9).toString("base64url")}`;
const sorted = (codes: readonly string[]) => [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// KAN-51: the development seed runs as erp_migrator (like db:seed); the API then logs in as erp_app over real HTTP.
describe("development seed (PostgreSQL: seed as erp_migrator, login as erp_app)", () => {
  let owner: PrismaClient;
  let http: HttpApp;
  let first: DevSeedSummary;
  let second: DevSeedSummary;
  let countsAfterFirst: Record<string, number>;
  let countsAfterSecond: Record<string, number>;

  /** Every row of the demo tenant, table by table (plus the snapshot of the mutable columns that must not change). */
  async function snapshot(tenantId: string): Promise<Record<string, number>> {
    const where = { tenantId };
    return {
      companies: await owner.company.count({ where }),
      branches: await owner.branch.count({ where }),
      users: await owner.user.count({ where }),
      branchAccesses: await owner.userBranchAccess.count({ where }),
      roles: await owner.role.count({ where }),
      kitchenSectors: await owner.kitchenSector.count({ where }),
      rolePermissions: await owner.rolePermission.count({ where }),
      userRoles: await owner.userRole.count({ where }),
      categories: await owner.productCategory.count({ where }),
      products: await owner.product.count({ where }),
      optionGroups: await owner.productOptionGroup.count({ where }),
      options: await owner.productOption.count({ where }),
      branchSettings: await owner.branchProductSetting.count({ where }),
      tenantsWithDemoCode: await owner.tenant.count({ where: { loginCode: "DEMO" } }),
    };
  }

  beforeAll(async () => {
    owner = createPrismaClient(inject("databaseUrl"));
    await ensurePermissionCatalog(owner);
    first = await seedDevData(owner, { password: PASSWORD });
    countsAfterFirst = await snapshot(first.tenantId);
    second = await seedDevData(owner, { password: PASSWORD });
    countsAfterSecond = await snapshot(first.tenantId);
    http = await startHttpApp(createPrismaClient(inject("appDatabaseUrl")), testAuthConfig({ AUTH_ALLOWED_ORIGINS: ORIGIN, AUTH_COOKIE_SECURE: "false" }));
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  it("is idempotent: the second run creates nothing and changes no count", async () => {
    expect(first.tenantCreated).toBe(true);
    expect(first.created).toEqual({ roles: 4, kitchenSectors: 1, companies: 1, branches: 3, users: 6, branchAccesses: 9, userRoles: 6, categories: 3, products: 10, branchSettings: 2 });
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.tenantCreated).toBe(false);
    expect(Object.values(second.created).every((n) => n === 0)).toBe(true);
    expect(countsAfterSecond).toEqual(countsAfterFirst);
    expect(countsAfterFirst).toMatchObject({ companies: 1, branches: 3, users: 6, roles: 4, kitchenSectors: 1, userRoles: 6, categories: 3, products: 10, tenantsWithDemoCode: 1 });
  });

  it("keeps existing rows untouched on a re-run (password hash, status, prices)", async () => {
    const before = await owner.user.findMany({ where: { tenantId: first.tenantId }, orderBy: { employeeNumber: "asc" } });
    await seedDevData(owner, { password: `${PASSWORD}-outra` });
    const after = await owner.user.findMany({ where: { tenantId: first.tenantId }, orderBy: { employeeNumber: "asc" } });
    expect(after).toEqual(before);
  });

  it("creates the demo organization, company, branches, users and catalog as specified", async () => {
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { loginCode: "DEMO" } });
    expect(tenant).toMatchObject({ name: "Restaurante Demo", status: TenantStatus.ACTIVE });
    const company = await owner.company.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(company).toMatchObject({ cnpj: "12ABC34501DE35", timezone: "America/Sao_Paulo", status: "ACTIVE" });

    const branches = await owner.branch.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: "asc" } });
    expect(branches.map((b) => [b.code, b.status])).toEqual(DEMO_BRANCHES.map((b) => [b.code, b.status]));
    expect(branches.find((b) => b.code === "ANTIGA")!.status).toBe(BranchStatus.INACTIVE);

    const users = await owner.user.findMany({
      where: { tenantId: tenant.id },
      include: { roles: { include: { role: true } }, branchAccesses: { include: { branch: true } } },
    });
    for (const def of DEMO_USERS) {
      const user = users.find((u) => u.employeeNumber === def.employeeNumber)!;
      expect(user, def.employeeNumber).toMatchObject({ status: UserStatus.ACTIVE, mustChangePassword: def.mustChangePassword });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.roles.map((r) => [r.role.code, r.branchId])).toEqual([[def.role, null]]);
      expect(user.branchAccesses.map((a) => a.branch.code).sort()).toEqual([...def.branches].sort());
    }
    expect(containsSecret(users, [PASSWORD])).toBe(false);

    const products = await owner.product.findMany({ where: { tenantId: tenant.id }, include: { optionGroups: { include: { options: true } } } });
    expect(products.map((p) => p.code).sort()).toEqual(DEMO_PRODUCTS.map((p) => p.code).sort());
    const byCode = (code: string) => products.find((p) => p.code === code)!;
    expect(byCode("HOTDOG").status).toBe(ProductStatus.INACTIVE);
    expect(byCode("BATATA").optionGroups.map((g) => [g.name, g.minChoices, g.maxChoices, g.options.length])).toEqual([["Tamanho", 1, 1, 3]]);
    expect(byCode("XSALADA").optionGroups.map((g) => [g.name, g.minChoices, g.maxChoices, g.options.length])).toEqual([["Adicionais", 0, 3, 3]]);
    const combo = byCode("COMBO1").optionGroups[0]!;
    expect(combo.options.map((o) => o.linkedProductId).sort()).toEqual([byCode("REFRI").id, byCode("SUCO").id, byCode("AGUA").id].sort());

    const shopping = branches.find((b) => b.code === "SHOPPING")!;
    const settings = await owner.branchProductSetting.findMany({ where: { tenantId: tenant.id } });
    expect(settings.map((s) => [s.branchId, s.productId, s.available, s.price?.toFixed(2) ?? null]).sort()).toEqual(
      [
        [shopping.id, byCode("XBURGER").id, true, "27.90"],
        [shopping.id, byCode("PUDIM").id, false, null],
      ].sort(),
    );
  });

  const login = (employeeNumber: string, password = PASSWORD) =>
    http.request("/auth/login", { method: "POST", headers: { origin: ORIGIN }, body: { loginCode: "demo", employeeNumber, password } });

  it("lets CAIXA1 log in over HTTP with DEMO and read GET /me; TROCASENHA must change the password", async () => {
    const res = await login("caixa1");
    expect(res.status).toBe(200);
    const body = res.body as { accessToken: string; mustChangePassword: boolean };
    expect(body.mustChangePassword).toBe(false);

    const me = await http.request("/me", { token: body.accessToken });
    expect(me.status).toBe(200);
    const dto = me.body as MeDto;
    expect(dto.user).toMatchObject({ employeeNumber: "CAIXA1", mustChangePassword: false });
    expect(dto.organization).toMatchObject({ name: "Restaurante Demo", loginCode: "DEMO", status: "ACTIVE" });
    expect(dto.permissions).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS.ATTENDANT));
    expect(dto.branches.map((b) => [b.code, b.operable, b.permissions])).toEqual([["CENTRO", true, sorted(DEFAULT_ROLE_PERMISSIONS.ATTENDANT)]]);

    const dono = (await login("DONO")).body as { accessToken: string };
    const ownerMe = (await http.request("/me", { token: dono.accessToken })).body as MeDto;
    expect(ownerMe.branches.map((b) => [b.code, b.operable])).toEqual([["CENTRO", true], ["SHOPPING", true], ["ANTIGA", false]]);

    const pending = await login("TROCASENHA");
    expect(pending.status).toBe(200);
    expect((pending.body as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    expect((await http.request("/me", { token: (pending.body as { accessToken: string }).accessToken })).status).toBe(403);

    expect(await login("CAIXA1", "senha-errada")).toEqual({ status: 401, body: { error: "invalid_credentials" } });
  });
});
