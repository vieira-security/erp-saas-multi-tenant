import { randomUUID } from "node:crypto";
import type { BranchAccessDto, BranchDto, BranchSummaryDto, CompanyDto, OrganizationDto, Page } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BranchStatus, CompanyStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

// Valid CNPJs (module 11). Org fixtures use company CNPJ 11222333000181 (root 11222333).
const SAME_ROOT_BRANCH_CNPJ = "11222333000262";
const OTHER_ROOT_CNPJ = "12345678000195";
const ALNUM_CNPJ = "12ABC34501DE35";

type Role = "OWNER" | "MANAGER" | "ATTENDANT" | "KITCHEN";

interface Actor {
  readonly userId: string;
  readonly token: string;
}

// M3 over real HTTP: AppModule (AuthGuard, PermissionGuard, filters), runtime identity erp_app, default roles provisioned.
describe("M3 organization APIs over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;
  const actors: Record<string, Actor> = {};

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config);
    await ensurePermissionCatalog(owner);
    orgA = await seedOrg(owner, "Org A");
    orgB = await seedOrg(owner, "Org B");
    const provisioning = new TenantProvisioningService(prisma, h.scope);
    for (const org of [orgA, orgB]) await h.tenants.run({ tenantId: org.tenantId }, () => provisioning.provisionDefaultRoles());
    // Every default role, tenant-wide, with access to MAIN only (not OTHER) — unless stated otherwise in a test.
    for (const role of ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"] as const) actors[`A:${role}`] = await actor(orgA, role, [orgA.branchId]);
    actors["B:OWNER"] = await actor(orgB, "OWNER", [orgB.branchId]);
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  async function roleId(org: Org, code: Role): Promise<string> {
    return (await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code } } })).id;
  }

  /** User with `role` tenant-wide and access to `branches`, logged in. */
  async function actor(org: Org, role: Role | null, branches: string[] = []): Promise<Actor> {
    const user = await seedUser(owner, org.tenantId);
    for (const branchId of branches) await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId } });
    if (role) await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId: await roleId(org, role) } });
    const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123" });
    return { userId: user.id, token: tokens.accessToken };
  }

  const as = (key: string) => actors[key]!.token;
  const call = (key: string, path: string, init: { method?: string; body?: unknown } = {}) => http.request(path, { ...init, token: as(key) });

  async function newCompany(org: Org, cnpj: string, status: CompanyStatus = CompanyStatus.ACTIVE): Promise<string> {
    const company = await owner.company.create({
      data: { tenantId: org.tenantId, legalName: "Extra Ltda", tradeName: "Extra", cnpj, status, timezone: "America/Manaus" },
    });
    return company.id;
  }

  async function newBranch(org: Org, companyId: string, code: string, status: BranchStatus = BranchStatus.ACTIVE): Promise<string> {
    const branch = await owner.branch.create({ data: { tenantId: org.tenantId, companyId, name: code, code, status, timezone: "America/Sao_Paulo" } });
    return branch.id;
  }

  /** A fresh tenant with its own company (for tests that need an isolated company list). */
  async function freshOrg(name: string): Promise<{ org: Org; owner: Actor }> {
    const org = await seedOrg(owner, name);
    await h.tenants.run({ tenantId: org.tenantId }, () => new TenantProvisioningService(prisma, h.scope).provisionDefaultRoles());
    return { org, owner: await actor(org, "OWNER", [org.branchId]) };
  }

  describe("authentication and authorization", () => {
    it("requires a token on every route", async () => {
      for (const path of ["/organization", "/companies", "/branches", "/me/branches", `/users/${randomUUID()}/branch-access`]) {
        expect(await http.request(path), path).toEqual({ status: 401, body: { error: "unauthenticated" } });
      }
    });

    it("applies the default role matrix by permission code", async () => {
      const matrix: [string, string, string, number][] = [
        ["GET", "/organization", "A:KITCHEN", 403],
        ["GET", "/organization", "A:ATTENDANT", 403],
        ["GET", "/organization", "A:MANAGER", 200],
        ["PATCH", "/organization", "A:MANAGER", 403],
        ["GET", "/companies", "A:ATTENDANT", 403],
        ["GET", "/companies", "A:MANAGER", 200],
        ["POST", "/companies", "A:MANAGER", 403],
        ["GET", "/branches", "A:KITCHEN", 403],
        ["GET", "/branches", "A:ATTENDANT", 200],
        ["POST", "/branches", "A:MANAGER", 403],
        ["GET", `/users/${actors["A:KITCHEN"]!.userId}/branch-access`, "A:KITCHEN", 403],
        ["GET", `/users/${actors["A:KITCHEN"]!.userId}/branch-access`, "A:MANAGER", 200],
        ["GET", "/me/branches", "A:KITCHEN", 200],
      ];
      for (const [method, path, who, status] of matrix) {
        const res = await call(who, path, { method, ...(method === "POST" || method === "PATCH" ? { body: {} } : {}) });
        expect(res.status, `${method} ${path} as ${who}`).toBe(status);
        if (status === 403) expect(res.body).toEqual({ error: "forbidden" });
      }
    });

    it("a user without any role gets 403 everywhere except /me", async () => {
      const nobody = await actor(orgA, null, [orgA.branchId]);
      expect((await http.request("/companies", { token: nobody.token })).status).toBe(403);
      expect(await http.request("/me/branches", { token: nobody.token })).toMatchObject({ status: 200 });
    });
  });

  describe("organization", () => {
    it("returns the authenticated tenant only, without internal fields", async () => {
      const res = await call("A:OWNER", "/organization");
      expect(res.status).toBe(200);
      const body = res.body as OrganizationDto;
      expect(body).toMatchObject({ id: orgA.tenantId, name: "Org A", status: "ACTIVE", loginCode: orgA.loginCode, trialEndsAt: null });
      expect(Object.keys(body).sort()).toEqual(["createdAt", "id", "loginCode", "name", "status", "trialEndsAt", "updatedAt"]);
      expect(((await call("B:OWNER", "/organization")).body as OrganizationDto).id).toBe(orgB.tenantId);
    });

    it("renames with trimming and rejects anything else in the body", async () => {
      const { owner: boss, org } = await freshOrg("Rename");
      const res = await http.request("/organization", { method: "PATCH", token: boss.token, body: { name: "  Novo Nome  " } });
      expect(res).toMatchObject({ status: 200, body: { id: org.tenantId, name: "Novo Nome" } });

      const bad = await http.request("/organization", { method: "PATCH", token: boss.token, body: { name: "", status: "CANCELLED", tenantId: orgA.tenantId } });
      expect(bad).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "status", issue: "unknown_field" },
            { field: "tenantId", issue: "unknown_field" },
            { field: "name", issue: "too_short" },
          ],
        },
      });
      expect((await owner.tenant.findUniqueOrThrow({ where: { id: org.tenantId } })).status).toBe("ACTIVE");
      expect((await owner.tenant.findUniqueOrThrow({ where: { id: orgA.tenantId } })).name).toBe("Org A");
    });
  });

  describe("companies", () => {
    it("creates with normalized CNPJ (alphanumeric, masked, lowercase) and canonical timezone", async () => {
      const { owner: boss } = await freshOrg("Create co");
      const res = await http.request("/companies", {
        method: "POST",
        token: boss.token,
        body: { legalName: " Nova Empresa Ltda ", tradeName: "Nova", cnpj: "12.abc.345/01de-35", timezone: "Brazil/East" },
      });
      expect(res.status).toBe(201);
      const company = res.body as CompanyDto;
      expect(company).toMatchObject({ legalName: "Nova Empresa Ltda", tradeName: "Nova", cnpj: ALNUM_CNPJ, status: "ACTIVE", timezone: "America/Sao_Paulo" });
      expect(Object.keys(company)).not.toContain("tenantId");

      const duplicate = await http.request("/companies", {
        method: "POST",
        token: boss.token,
        body: { legalName: "Outra", tradeName: "Outra", cnpj: ALNUM_CNPJ, timezone: "UTC" },
      });
      expect(duplicate).toEqual({ status: 409, body: { error: "company_cnpj_already_exists" } });
    });

    it("validates every field and reports all issues at once", async () => {
      const res = await call("A:OWNER", "/companies", {
        method: "POST",
        body: { legalName: "x".repeat(201), cnpj: "11222333000182", timezone: "-03:00", tenantId: orgB.tenantId },
      });
      expect(res).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "tenantId", issue: "unknown_field" },
            { field: "legalName", issue: "too_long" },
            { field: "tradeName", issue: "required" },
            { field: "cnpj", issue: "invalid_cnpj" },
            { field: "timezone", issue: "invalid_timezone" },
          ],
        },
      });
      expect((await call("A:OWNER", "/companies", { method: "POST", body: [] })).body).toEqual({
        error: "validation_failed",
        details: [{ field: "body", issue: "invalid_type" }],
      });
    });

    it("lists only the tenant's companies, paginated and filtered by status", async () => {
      const { org, owner: boss } = await freshOrg("List co");
      await newCompany(org, OTHER_ROOT_CNPJ);
      await newCompany(org, "98765432000198", CompanyStatus.INACTIVE);
      const page1 = await http.request("/companies?pageSize=2", { token: boss.token });
      expect(page1.status).toBe(200);
      const body = page1.body as Page<CompanyDto>;
      expect(body).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
      expect(body.items.map((c) => c.id)[0]).toBe(org.companyId);
      const page2 = (await http.request("/companies?pageSize=2&page=2", { token: boss.token })).body as Page<CompanyDto>;
      expect(page2.items).toHaveLength(1);
      expect([...body.items, ...page2.items].map((c) => c.id)).not.toContain(orgA.companyId);
      const inactive = (await http.request("/companies?status=INACTIVE", { token: boss.token })).body as Page<CompanyDto>;
      expect(inactive.items.map((c) => c.cnpj)).toEqual(["98765432000198"]);

      expect((await http.request("/companies?pageSize=500&foo=1&status=DELETED", { token: boss.token })).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "foo", issue: "unknown_field" },
          { field: "pageSize", issue: "invalid_value" },
          { field: "status", issue: "invalid_value" },
        ],
      });
    });

    it("another tenant's company is indistinguishable from a missing one", async () => {
      for (const path of [`/companies/${orgA.companyId}`, `/companies/${randomUUID()}`, "/companies/not-a-uuid"]) {
        expect(await call("B:OWNER", path), path).toEqual({ status: 404, body: { error: "not_found" } });
      }
      for (const action of ["deactivate", "activate"]) {
        expect(await call("B:OWNER", `/companies/${orgA.companyId}/${action}`, { method: "POST" })).toEqual({ status: 404, body: { error: "not_found" } });
      }
      expect(await call("B:OWNER", `/companies/${orgA.companyId}`, { method: "PATCH", body: { tradeName: "Hack" } })).toEqual({
        status: 404,
        body: { error: "not_found" },
      });
      expect((await owner.company.findUniqueOrThrow({ where: { id: orgA.companyId } })).tradeName).toBe("Org A");
    });

    it("updates names and timezone; CNPJ and status are not editable by PATCH", async () => {
      const { org, owner: boss } = await freshOrg("Patch co");
      const res = await http.request(`/companies/${org.companyId}`, { method: "PATCH", token: boss.token, body: { tradeName: "Renomeada", timezone: "America/Manaus" } });
      expect(res).toMatchObject({ status: 200, body: { tradeName: "Renomeada", timezone: "America/Manaus", cnpj: "11222333000181" } });
      const before = (await owner.company.findUniqueOrThrow({ where: { id: org.companyId } })).updatedAt;
      expect((await http.request(`/companies/${org.companyId}`, { method: "PATCH", token: boss.token, body: {} })).status).toBe(200);
      expect((await owner.company.findUniqueOrThrow({ where: { id: org.companyId } })).updatedAt).toEqual(before);
      expect((await http.request(`/companies/${org.companyId}`, { method: "PATCH", token: boss.token, body: { cnpj: OTHER_ROOT_CNPJ, status: "INACTIVE" } })).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "cnpj", issue: "unknown_field" },
          { field: "status", issue: "unknown_field" },
        ],
      });
    });

    it("cannot be deactivated while it has an active branch; activate/deactivate are idempotent", async () => {
      const { org, owner: boss } = await freshOrg("Deactivate co");
      const post = (path: string) => http.request(path, { method: "POST", token: boss.token });
      expect(await post(`/companies/${org.companyId}/deactivate`)).toEqual({ status: 409, body: { error: "company_has_active_branches" } });
      for (const branchId of [org.branchId, org.otherBranchId]) expect((await post(`/branches/${branchId}/deactivate`)).status).toBe(200);
      expect(await post(`/companies/${org.companyId}/deactivate`)).toMatchObject({ status: 200, body: { status: "INACTIVE" } });
      expect(await post(`/companies/${org.companyId}/deactivate`)).toMatchObject({ status: 200, body: { status: "INACTIVE" } });
      expect(await post(`/branches/${org.branchId}/activate`)).toEqual({ status: 409, body: { error: "company_inactive" } });
      expect(await post(`/companies/${org.companyId}/activate`)).toMatchObject({ status: 200, body: { status: "ACTIVE" } });
      expect(await post(`/companies/${org.companyId}/activate`)).toMatchObject({ status: 200, body: { status: "ACTIVE" } });
      expect(await post(`/branches/${org.branchId}/activate`)).toMatchObject({ status: 200, body: { status: "ACTIVE" } });
    });
  });

  describe("branches", () => {
    it("creates with normalized code, inherited timezone and a CNPJ sharing the company root", async () => {
      const { org, owner: boss } = await freshOrg("Create br");
      const res = await http.request("/branches", {
        method: "POST",
        token: boss.token,
        body: { companyId: org.companyId.toUpperCase(), name: " Shopping Eldorado ", code: " eldorado-01 ", cnpj: "11.222.333/0002-62" },
      });
      expect(res.status).toBe(201);
      expect(res.body as BranchDto).toMatchObject({
        companyId: org.companyId,
        name: "Shopping Eldorado",
        code: "ELDORADO-01",
        cnpj: SAME_ROOT_BRANCH_CNPJ,
        status: "ACTIVE",
        timezone: "America/Sao_Paulo",
      });

      const post = (body: unknown) => http.request("/branches", { method: "POST", token: boss.token, body });
      expect(await post({ companyId: org.companyId, name: "X", code: "Eldorado-01" })).toEqual({ status: 409, body: { error: "branch_code_already_exists" } });
      expect(await post({ companyId: org.companyId, name: "X", code: "NOVA", cnpj: SAME_ROOT_BRANCH_CNPJ })).toEqual({
        status: 409,
        body: { error: "branch_cnpj_already_exists" },
      });
      expect(await post({ companyId: org.companyId, name: "X", code: "RAIZ", cnpj: OTHER_ROOT_CNPJ })).toEqual({
        status: 400,
        body: { error: "validation_failed", details: [{ field: "cnpj", issue: "cnpj_root_mismatch" }] },
      });
      expect(await post({ companyId: org.companyId, name: "X", code: "SEM-CNPJ", cnpj: null, timezone: "America/Manaus" })).toMatchObject({
        status: 201,
        body: { cnpj: null, timezone: "America/Manaus" },
      });
      expect(await post({ companyId: orgA.companyId, name: "X", code: "INVASAO" })).toEqual({ status: 404, body: { error: "not_found" } });
      expect(await post({ companyId: org.companyId, name: "X", code: "-X", status: "INACTIVE" })).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "status", issue: "unknown_field" },
            { field: "code", issue: "invalid_format" },
          ],
        },
      });
      expect(await owner.branch.count({ where: { tenantId: orgA.tenantId, code: "INVASAO" } })).toBe(0);
    });

    it("cannot be created under an inactive company", async () => {
      const { org, owner: boss } = await freshOrg("Inactive co");
      const companyId = await newCompany(org, OTHER_ROOT_CNPJ, CompanyStatus.INACTIVE);
      expect(await http.request("/branches", { method: "POST", token: boss.token, body: { companyId, name: "X", code: "X" } })).toEqual({
        status: 409,
        body: { error: "company_inactive" },
      });
    });

    it("lists and reads only the tenant's branches; another tenant's branch is 404", async () => {
      const list = (await call("A:ATTENDANT", `/branches?companyId=${orgA.companyId}`)).body as Page<BranchDto>;
      expect(list.items.map((b) => b.id)).toEqual(expect.arrayContaining([orgA.branchId, orgA.otherBranchId]));
      expect(list.items.every((b) => b.companyId === orgA.companyId)).toBe(true);
      expect(((await call("B:OWNER", `/branches?companyId=${orgA.companyId}`)).body as Page<BranchDto>).total).toBe(0);
      expect(await call("B:OWNER", `/branches/${orgA.branchId}`)).toEqual({ status: 404, body: { error: "not_found" } });
      expect(await call("B:OWNER", `/branches/${orgA.branchId}`, { method: "PATCH", body: { name: "Hack" } })).toEqual({ status: 404, body: { error: "not_found" } });
      expect(await call("B:OWNER", `/branches/${orgA.branchId}/deactivate`, { method: "POST" })).toEqual({ status: 404, body: { error: "not_found" } });
      expect((await owner.branch.findUniqueOrThrow({ where: { id: orgA.branchId } })).status).toBe("ACTIVE");
      expect(await call("A:ATTENDANT", `/branches/${orgA.otherBranchId}`)).toMatchObject({ status: 200, body: { id: orgA.otherBranchId } });
    });

    it("updates code (normalized, unique), CNPJ (root checked, null removes) and keeps companyId immutable", async () => {
      const { org, owner: boss } = await freshOrg("Patch br");
      const patch = (body: unknown) => http.request(`/branches/${org.branchId}`, { method: "PATCH", token: boss.token, body });
      expect(await patch({ code: "other" })).toEqual({ status: 409, body: { error: "branch_code_already_exists" } });
      expect(await patch({ code: "main" })).toMatchObject({ status: 200, body: { code: "MAIN" } });
      expect(await patch({ code: "centro", cnpj: SAME_ROOT_BRANCH_CNPJ })).toMatchObject({ status: 200, body: { code: "CENTRO", cnpj: SAME_ROOT_BRANCH_CNPJ } });
      expect(await patch({ cnpj: OTHER_ROOT_CNPJ })).toEqual({ status: 400, body: { error: "validation_failed", details: [{ field: "cnpj", issue: "cnpj_root_mismatch" }] } });
      expect(await http.request(`/branches/${org.otherBranchId}`, { method: "PATCH", token: boss.token, body: { cnpj: SAME_ROOT_BRANCH_CNPJ } })).toEqual({
        status: 409,
        body: { error: "branch_cnpj_already_exists" },
      });
      expect(await patch({ cnpj: null })).toMatchObject({ status: 200, body: { cnpj: null } });
      expect((await patch({ companyId: orgA.companyId })).body).toEqual({ error: "validation_failed", details: [{ field: "companyId", issue: "unknown_field" }] });
    });
  });

  describe("/me/branches", () => {
    it("lists only branches the user can operate: with access, active branch, active company", async () => {
      const { org } = await freshOrg("Me");
      const otherCompany = await newCompany(org, OTHER_ROOT_CNPJ);
      const underInactive = await newBranch(org, otherCompany, "SOB-INATIVA");
      const inactive = await newBranch(org, org.companyId, "INATIVA", BranchStatus.INACTIVE);
      const me = await actor(org, "KITCHEN", [org.branchId, inactive, underInactive]);
      await owner.company.update({ where: { id: otherCompany }, data: { status: CompanyStatus.INACTIVE } });

      const res = await http.request("/me/branches", { token: me.token });
      expect(res.status).toBe(200);
      expect(res.body as BranchSummaryDto[]).toEqual([{ id: org.branchId, companyId: org.companyId, name: "MAIN", code: "MAIN", status: "ACTIVE" }]);
    });
  });

  describe("branch access", () => {
    it("grants idempotently (201 then 200) and lists the user's access", async () => {
      const target = await actor(orgA, "ATTENDANT");
      const url = `/users/${target.userId}/branch-access/${orgA.branchId}`;
      const first = await call("A:OWNER", url, { method: "PUT" });
      expect(first.status).toBe(201);
      expect(first.body as BranchAccessDto).toMatchObject({ userId: target.userId, branchId: orgA.branchId, branch: { id: orgA.branchId, code: "MAIN" } });
      expect((await call("A:OWNER", url, { method: "PUT" })).status).toBe(200);
      const list = await call("A:MANAGER", `/users/${target.userId}/branch-access`);
      expect((list.body as BranchAccessDto[]).map((a) => a.branchId)).toEqual([orgA.branchId]);
    });

    it("requires user.manage IN the target branch: no access to the branch = 403, even for OWNER", async () => {
      const target = await actor(orgA, "ATTENDANT");
      // A:OWNER and A:MANAGER only have access to MAIN.
      for (const who of ["A:OWNER", "A:MANAGER"]) {
        expect(await call(who, `/users/${target.userId}/branch-access/${orgA.otherBranchId}`, { method: "PUT" }), who).toEqual({ status: 403, body: { error: "forbidden" } });
      }
      expect(await call("A:ATTENDANT", `/users/${target.userId}/branch-access/${orgA.branchId}`, { method: "PUT" })).toEqual({ status: 403, body: { error: "forbidden" } });
      expect(await call("A:MANAGER", `/users/${target.userId}/branch-access/${orgA.branchId}`, { method: "PUT" })).toMatchObject({ status: 201 });
      // Branch of another tenant, unknown or malformed: the guard denies before anything is read.
      for (const branchId of [orgB.branchId, randomUUID(), "nope"]) {
        expect((await call("A:OWNER", `/users/${target.userId}/branch-access/${branchId}`, { method: "PUT" })).status).toBe(403);
      }
      expect(await owner.userBranchAccess.count({ where: { userId: target.userId } })).toBe(1);
    });

    it("unknown or foreign users are 404; inactive branches cannot receive new access", async () => {
      for (const userId of [actors["B:OWNER"]!.userId, randomUUID(), "nope"]) {
        expect(await call("A:OWNER", `/users/${userId}/branch-access/${orgA.branchId}`, { method: "PUT" }), userId).toEqual({ status: 404, body: { error: "not_found" } });
        expect(await call("A:OWNER", `/users/${userId}/branch-access`), userId).toEqual({ status: 404, body: { error: "not_found" } });
      }
      const { org, owner: boss } = await freshOrg("Inactive access");
      const target = await actor(org, "ATTENDANT");
      // The OWNER needs access to the branch to pass the guard; then the branch is deactivated.
      await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: boss.userId, branchId: org.otherBranchId } });
      await owner.branch.update({ where: { id: org.otherBranchId }, data: { status: BranchStatus.INACTIVE } });
      expect(await http.request(`/users/${target.userId}/branch-access/${org.otherBranchId}`, { method: "PUT", token: boss.token })).toEqual({
        status: 409,
        body: { error: "branch_inactive" },
      });
    });

    it("revokes (204), refuses while a branch-scoped role depends on it (409) and 404s when absent", async () => {
      const target = await actor(orgA, null, [orgA.branchId]);
      await owner.userRole.create({ data: { tenantId: orgA.tenantId, userId: target.userId, roleId: await roleId(orgA, "KITCHEN"), branchId: orgA.branchId } });
      const url = `/users/${target.userId}/branch-access/${orgA.branchId}`;
      expect(await call("A:OWNER", url, { method: "DELETE" })).toEqual({ status: 409, body: { error: "branch_access_in_use" } });
      await owner.userRole.deleteMany({ where: { userId: target.userId } });
      expect(await call("A:OWNER", url, { method: "DELETE" })).toEqual({ status: 204, body: null });
      expect(await call("A:OWNER", url, { method: "DELETE" })).toEqual({ status: 404, body: { error: "not_found" } });
      expect(await owner.userBranchAccess.count({ where: { userId: target.userId } })).toBe(0);
    });
  });

  describe("concurrency", () => {
    it("never leaves an active branch under an inactive company (activate branch vs deactivate company)", async () => {
      for (let i = 0; i < 15; i++) {
        const { org, owner: boss } = await freshOrg(`Race ${i}`);
        await owner.branch.updateMany({ where: { tenantId: org.tenantId }, data: { status: BranchStatus.INACTIVE } });
        const post = (path: string) => http.request(path, { method: "POST", token: boss.token });
        const [branch, company] = await Promise.all([post(`/branches/${org.branchId}/activate`), post(`/companies/${org.companyId}/deactivate`)]);
        const statuses = [branch.status, company.status].sort();
        // Exactly one wins: branch activated (company refuses) or company deactivated (branch refuses).
        expect(statuses).toEqual([200, 409]);
        const [companyRow, branchRow] = await Promise.all([
          owner.company.findUniqueOrThrow({ where: { id: org.companyId } }),
          owner.branch.findUniqueOrThrow({ where: { id: org.branchId } }),
        ]);
        expect(companyRow.status === "INACTIVE" && branchRow.status === "ACTIVE").toBe(false);
      }
    });

    it("concurrent creations with the same code: one 201, the others 409", async () => {
      const { org, owner: boss } = await freshOrg("Race code");
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, n) =>
          http.request("/branches", { method: "POST", token: boss.token, body: { companyId: org.companyId, name: `N${n}`, code: n % 2 ? "dup" : " DUP " } }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => (r.body as { error: string }).error === "branch_code_already_exists")).toBe(true);
      expect(await owner.branch.count({ where: { tenantId: org.tenantId, code: "DUP" } })).toBe(1);
    });

    it("concurrent grants of the same access: no error, a single row", async () => {
      const target = await actor(orgA, "ATTENDANT");
      const url = `/users/${target.userId}/branch-access/${orgA.branchId}`;
      const results = await Promise.all(Array.from({ length: 5 }, () => call("A:OWNER", url, { method: "PUT" })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await owner.userBranchAccess.count({ where: { userId: target.userId } })).toBe(1);
    });
  });
});
