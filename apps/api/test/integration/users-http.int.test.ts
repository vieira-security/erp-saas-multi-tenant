import { randomUUID } from "node:crypto";
import type { Page, UserDto, UserSummaryDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RoleStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import type { DefaultRoleCode } from "../../src/tenants/default-roles.js";
import { DEFAULT_PASSWORD, authHarness, ensurePermissionCatalog, hashFor, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

// Exact key sets of the contract (packages/contracts/src/users.ts and BranchSummaryDto): anything else is a leak.
const SUMMARY_KEYS = ["createdAt", "employeeNumber", "id", "name", "status"];
const DETAIL_KEYS = [...SUMMARY_KEYS, "mustChangePassword", "roles", "updatedAt"].sort();
const ROLE_KEYS = ["branch", "code", "name", "roleId", "status"];
const BRANCH_SUMMARY_KEYS = ["code", "companyId", "id", "name", "status"];
const PAGE_KEYS = ["items", "page", "pageSize", "total", "totalPages"];
const SENSITIVE = /passwordHash|password_hash|failedLoginAttempts|lockedUntil|lastLoginAt|disabledAt|sessions|tenantId|tenant_id|\$argon2/;

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// GET /users and GET /users/:userId over real HTTP (AppModule, guards, filters), runtime identity erp_app.
describe("Users read API over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;
  const tokens: Record<string, string> = {};
  /** Users created in org A by name, for the search/order tests. */
  const ids: Record<string, string> = {};
  let otherTenantUser: { id: string; employeeNumber: string };
  let target: string;
  let customRoles: { inactive: string; archived: string };

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config);
    await ensurePermissionCatalog(owner);
    orgA = await seedOrg(owner, "Users A");
    orgB = await seedOrg(owner, "Users B");
    const provisioning = new TenantProvisioningService(prisma, h.scope);
    for (const org of [orgA, orgB]) await h.tenants.run({ tenantId: org.tenantId }, () => provisioning.provisionDefaultRoles());

    for (const role of ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"] as const) tokens[role] = await login(orgA, role);
    tokens["B:OWNER"] = await login(orgB, "OWNER");
    tokens["NO_ROLE"] = await loginAs(orgA, (await seedUser(owner, orgA.tenantId, { employeeNumber: nextActorNumber() })).employeeNumber);

    const people: [string, string, UserStatus][] = [
      ["Ana Souza", "A100", UserStatus.ACTIVE],
      ["ANA PAULA", "A200", UserStatus.ACTIVE],
      ["Bruno Ana", "B300", UserStatus.DISABLED],
      ["Carla Lima", "C400", UserStatus.LOCKED],
      ["Mariana", "M500", UserStatus.ACTIVE],
      ["Taxa 100% Real", "P001", UserStatus.ACTIVE],
      ["Taxa 1000 Real", "P002", UserStatus.ACTIVE],
      ["Joao_Silva", "J001", UserStatus.ACTIVE],
      ["JoaoXSilva", "J002", UserStatus.ACTIVE],
      ["Qx beta", "Q001", UserStatus.ACTIVE],
      ["Qx Zulu", "Q002", UserStatus.ACTIVE],
      ["Qx Alpha", "Q003", UserStatus.ACTIVE],
      ["Twin Name", "T001", UserStatus.ACTIVE],
      ["Twin Name", "T002", UserStatus.ACTIVE],
      ["Twin Name", "T003", UserStatus.ACTIVE],
      ...[5, 3, 1, 4, 2].map((n): [string, string, UserStatus] => [`Pg Item ${n}`, `PG${n}`, UserStatus.ACTIVE]),
    ];
    for (const [name, employeeNumber, status] of people) ids[employeeNumber] = await createUser(orgA, name, employeeNumber, status);
    otherTenantUser = await seedUser(owner, orgB.tenantId, { employeeNumber: "A100" });

    // Detail fixture: tenant-wide OWNER + INACTIVE + ARCHIVED roles, ATTENDANT at MAIN, MANAGER at OTHER.
    target = await createUser(orgA, "Detail Target", "D001", UserStatus.ACTIVE, { mustChangePassword: true });
    for (const branchId of [orgA.branchId, orgA.otherBranchId]) {
      await owner.userBranchAccess.create({ data: { tenantId: orgA.tenantId, userId: target, branchId } });
    }
    customRoles = {
      inactive: (await owner.role.create({ data: { tenantId: orgA.tenantId, code: "OFFROLE", name: "Desligada", status: RoleStatus.INACTIVE } })).id,
      archived: (await owner.role.create({ data: { tenantId: orgA.tenantId, code: "OLDROLE", name: "Arquivada", status: RoleStatus.ARCHIVED } })).id,
    };
    const assignments: [string, string | null][] = [
      [await roleIdOf(orgA, "MANAGER"), orgA.otherBranchId],
      [await roleIdOf(orgA, "OWNER"), null],
      [await roleIdOf(orgA, "ATTENDANT"), orgA.branchId],
      [customRoles.archived, null],
      [customRoles.inactive, null],
    ];
    for (const [roleId, branchId] of assignments) {
      await owner.userRole.create({ data: { tenantId: orgA.tenantId, userId: target, roleId, branchId } });
    }
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  async function roleIdOf(org: Org, code: DefaultRoleCode): Promise<string> {
    return (await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code } } })).id;
  }

  async function createUser(org: Org, name: string, employeeNumber: string, status: UserStatus, extra: { mustChangePassword?: boolean } = {}): Promise<string> {
    const user = await owner.user.create({
      data: {
        tenantId: org.tenantId,
        name,
        employeeNumber,
        passwordHash: await hashFor(DEFAULT_PASSWORD),
        status,
        mustChangePassword: extra.mustChangePassword ?? false,
        // Sensitive columns filled in on purpose, so a leak would show up in the responses.
        failedLoginAttempts: 3,
        lastLoginAt: new Date(),
        ...(status === UserStatus.DISABLED ? { disabledAt: new Date() } : {}),
        ...(status === UserStatus.LOCKED ? { lockedUntil: new Date(Date.now() + 3_600_000) } : {}),
      },
    });
    return user.id;
  }

  async function loginAs(org: Org, employeeNumber: string): Promise<string> {
    return (await h.auth.login({ tenantId: org.tenantId }, { employeeNumber, password: DEFAULT_PASSWORD })).accessToken;
  }

  /**
   * Fixed actor numbers (not seedUser's random hex): the actors are named `User ZZ0n`, so no search term of these tests
   * can match them by accident.
   */
  let actorCount = 0;
  const nextActorNumber = () => `ZZ0${++actorCount}`;

  /** User with a tenant-wide default role, logged in. */
  async function login(org: Org, role: DefaultRoleCode): Promise<string> {
    const user = await seedUser(owner, org.tenantId, { employeeNumber: nextActorNumber() });
    await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId: org.branchId } });
    await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId: await roleIdOf(org, role), branchId: null } });
    return loginAs(org, user.employeeNumber);
  }

  async function list(query: string, who = "MANAGER"): Promise<Page<UserSummaryDto>> {
    const res = await http.request(`/users${query}`, { token: tokens[who]! });
    expect(res.status, `GET /users${query}`).toBe(200);
    return res.body as Page<UserSummaryDto>;
  }

  const numbers = (page: Page<UserSummaryDto>) => page.items.map((u) => u.employeeNumber);
  const search = (term: string) => `?search=${encodeURIComponent(term)}`;

  describe("authentication and authorization", () => {
    it("requires a token (401)", async () => {
      for (const path of ["/users", `/users/${target}`]) {
        expect(await http.request(path), path).toEqual({ status: 401, body: { error: "unauthenticated" } });
      }
    });

    it("requires user.read: 403 for ATTENDANT, KITCHEN and a user without roles; 200 for OWNER and MANAGER", async () => {
      for (const who of ["ATTENDANT", "KITCHEN", "NO_ROLE"]) {
        for (const path of ["/users", `/users/${target}`]) {
          expect(await http.request(path, { token: tokens[who]! }), `${who} ${path}`).toEqual({ status: 403, body: { error: "forbidden" } });
        }
      }
      for (const who of ["OWNER", "MANAGER"]) {
        for (const path of ["/users", `/users/${target}`]) {
          expect((await http.request(path, { token: tokens[who]! })).status, `${who} ${path}`).toBe(200);
        }
      }
    });
  });

  describe("tenant isolation", () => {
    it("never lists a user of another tenant", async () => {
      const a = await list(search("A100"));
      expect(a.items.map((u) => u.id)).toEqual([ids["A100"]]);
      const everyone = await list("?pageSize=100");
      expect(everyone.items.map((u) => u.id)).not.toContain(otherTenantUser.id);

      const b = await list("?pageSize=100", "B:OWNER");
      expect(b.items.map((u) => u.id)).toContain(otherTenantUser.id);
      expect(b.items.map((u) => u.id)).not.toContain(ids["A100"]);
      expect(b.total).toBe(2); // the B:OWNER actor and the A100 homonym
    });

    it("answers 404 for a user of another tenant, an unknown id and a non-UUID id", async () => {
      for (const id of [otherTenantUser.id, randomUUID(), "not-a-uuid", "123"]) {
        expect(await http.request(`/users/${id}`, { token: tokens["MANAGER"]! }), id).toEqual({ status: 404, body: { error: "not_found" } });
      }
      expect(await http.request(`/users/${target}`, { token: tokens["B:OWNER"]! })).toEqual({ status: 404, body: { error: "not_found" } });
    });

    it("rejects tenantId in the query", async () => {
      const res = await http.request(`/users?tenantId=${orgB.tenantId}`, { token: tokens["MANAGER"]! });
      expect(res).toEqual({ status: 400, body: { error: "validation_failed", details: [{ field: "tenantId", issue: "unknown_field" }] } });
    });
  });

  describe("query validation (400 validation_failed)", () => {
    it("reports invalid status, empty/long search, unknown fields and pageSize above 100", async () => {
      const cases: [string, { field: string; issue: string }[]][] = [
        ["?status=ARCHIVED", [{ field: "status", issue: "invalid_value" }]],
        ["?search=%20%20", [{ field: "search", issue: "too_short" }]],
        ["?search=", [{ field: "search", issue: "too_short" }]],
        [`?search=${"x".repeat(101)}`, [{ field: "search", issue: "too_long" }]],
        ["?sort=name", [{ field: "sort", issue: "unknown_field" }]],
        ["?pageSize=101", [{ field: "pageSize", issue: "invalid_value" }]],
      ];
      for (const [query, details] of cases) {
        expect(await http.request(`/users${query}`, { token: tokens["MANAGER"]! }), query).toEqual({ status: 400, body: { error: "validation_failed", details } });
      }
    });
  });

  describe("filters", () => {
    it("filters by status", async () => {
      expect(numbers(await list("?status=LOCKED&pageSize=100"))).toEqual(["C400"]);
      expect(numbers(await list("?status=DISABLED&pageSize=100"))).toEqual(["B300"]);
      const active = numbers(await list("?status=ACTIVE&pageSize=100"));
      expect(active).toContain("A100");
      expect(active).not.toContain("B300");
      expect(active).not.toContain("C400");
    });

    it("searches the name case-insensitively (contains)", async () => {
      const expected = ["A200", "A100", "B300", "M500"]; // "ANA PAULA" < "Ana Souza" < "Bruno Ana" < "Mariana" (code point)
      expect(numbers(await list(search("ana")))).toEqual(expected);
      expect(numbers(await list(search("ANA")))).toEqual(expected);
      expect(numbers(await list(search("  aNa  ")))).toEqual(expected);
      expect(numbers(await list(`${search("ana")}&status=ACTIVE`))).toEqual(["A200", "A100", "M500"]);
    });

    it("matches the employee number exactly (normalized like the login), never partially", async () => {
      expect(numbers(await list(search("C400")))).toEqual(["C400"]);
      expect(numbers(await list(search("c400")))).toEqual(["C400"]);
      expect(numbers(await list(search("C40")))).toEqual([]);
      expect(numbers(await list(search("400")))).toEqual([]);
      expect(numbers(await list(search("pg1")))).toEqual(["PG1"]); // by number; the name "Pg Item 1" does not contain "pg1"
      expect(numbers(await list(search("A1")))).toEqual([]);
    });

    it("treats % and _ in the term as literal text", async () => {
      expect(numbers(await list(search("100%")))).toEqual(["P001"]);
      expect(numbers(await list(search("%")))).toEqual(["P001"]);
      expect(numbers(await list(search("o_S")))).toEqual(["J001"]);
      expect(numbers(await list(search("_")))).toEqual(["J001"]);
      expect(numbers(await list(search("\\")))).toEqual([]);
    });
  });

  describe("order and paging", () => {
    it("orders by name in code-point order (COLLATE \"C\"), independent of the database collation", async () => {
      expect((await list(search("Qx"))).items.map((u) => u.name)).toEqual(["Qx Alpha", "Qx Zulu", "Qx beta"]);
    });

    it("breaks name ties by id, stably", async () => {
      const twins = [ids["T001"]!, ids["T002"]!, ids["T003"]!].sort(byCode);
      expect((await list(search("Twin Name"))).items.map((u) => u.id)).toEqual(twins);
      const pages = [];
      for (const page of [1, 2, 3]) pages.push(...(await list(`${search("Twin Name")}&pageSize=1&page=${page}`)).items.map((u) => u.id));
      expect(pages).toEqual(twins);
    });

    it("paginates with total and totalPages of the same filter", async () => {
      const first = await list(`${search("Pg Item")}&pageSize=2`);
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
      expect(numbers(first)).toEqual(["PG1", "PG2"]);
      expect(numbers(await list(`${search("Pg Item")}&pageSize=2&page=2`))).toEqual(["PG3", "PG4"]);
      const last = await list(`${search("Pg Item")}&pageSize=2&page=3`);
      expect(last).toMatchObject({ page: 3, total: 5, totalPages: 3 });
      expect(numbers(last)).toEqual(["PG5"]);
      expect(await list(`${search("Pg Item")}&pageSize=2&page=4`)).toEqual({ items: [], page: 4, pageSize: 2, total: 5, totalPages: 3 });
      expect(await list(search("nobody-by-this-name"))).toEqual({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
    });

    it("uses the default page size of 20", async () => {
      const page = await list("");
      expect(page).toMatchObject({ page: 1, pageSize: 20 });
      expect(page.items.length).toBe(Math.min(20, page.total));
    });
  });

  describe("response shape", () => {
    it("lists exactly the UserSummaryDto keys, without any sensitive field", async () => {
      const page = await list("?pageSize=100");
      expect(Object.keys(page).sort()).toEqual(PAGE_KEYS);
      expect(page.items.length).toBeGreaterThan(20);
      for (const item of page.items) expect(Object.keys(item).sort(), item.employeeNumber).toEqual(SUMMARY_KEYS);
      expect(JSON.stringify(page)).not.toMatch(SENSITIVE);
      const locked = page.items.find((u) => u.employeeNumber === "C400")!;
      expect(locked).toEqual({ id: ids["C400"], name: "Carla Lima", employeeNumber: "C400", status: "LOCKED", createdAt: expect.any(String) });
      expect(new Date(locked.createdAt).toISOString()).toBe(locked.createdAt);
    });

    it("returns the UserDto with every role assignment, in contract order, without any sensitive field", async () => {
      const res = await http.request(`/users/${target}`, { token: tokens["MANAGER"]! });
      expect(res.status).toBe(200);
      const dto = res.body as UserDto;
      expect(Object.keys(dto).sort()).toEqual(DETAIL_KEYS);
      expect(JSON.stringify(dto)).not.toMatch(SENSITIVE);
      expect(dto).toMatchObject({ id: target, name: "Detail Target", employeeNumber: "D001", status: "ACTIVE", mustChangePassword: true });
      expect(new Date(dto.updatedAt).toISOString()).toBe(dto.updatedAt);

      for (const role of dto.roles) {
        expect(Object.keys(role).sort()).toEqual(ROLE_KEYS);
        if (role.branch) expect(Object.keys(role.branch).sort()).toEqual(BRANCH_SUMMARY_KEYS);
      }
      // Tenant-wide first (by code), then by branch code (MAIN < OTHER), then by code.
      expect(dto.roles.map((r) => [r.code, r.status, r.branch?.code ?? null])).toEqual([
        ["OFFROLE", "INACTIVE", null],
        ["OLDROLE", "INACTIVE", null], // ARCHIVED is not in the contract: shown as INACTIVE
        ["OWNER", "ACTIVE", null],
        ["ATTENDANT", "ACTIVE", "MAIN"],
        ["MANAGER", "ACTIVE", "OTHER"],
      ]);
      expect(dto.roles[0]).toEqual({ roleId: customRoles.inactive, code: "OFFROLE", name: "Desligada", status: "INACTIVE", branch: null });
      expect(dto.roles[4]!.branch).toEqual({ id: orgA.otherBranchId, companyId: orgA.companyId, name: "OTHER", code: "OTHER", status: "ACTIVE" });
      expect(dto.roles[4]!.roleId).toBe(await roleIdOf(orgA, "MANAGER"));
    });

    it("returns an empty role list for a user without roles, whatever the user status", async () => {
      const res = await http.request(`/users/${ids["C400"]}`, { token: tokens["OWNER"]! });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: ids["C400"],
        name: "Carla Lima",
        employeeNumber: "C400",
        status: "LOCKED",
        mustChangePassword: false,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        roles: [],
      });
    });

    it("accepts an upper-case UUID in the route", async () => {
      expect((await http.request(`/users/${target.toUpperCase()}`, { token: tokens["MANAGER"]! })).status).toBe(200);
    });
  });
});
