import { randomBytes, randomUUID } from "node:crypto";
import type { RoleDto, UserDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RoleStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { DEFAULT_ROLE_PERMISSIONS, type DefaultRoleCode } from "../../src/tenants/default-roles.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { DEFAULT_PASSWORD, authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

const TEMP_PASSWORD = "Temporaria-Gestao-2026";
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const NOT_FOUND = { status: 404, body: { error: "not_found" } };
const conflict = (error: string) => ({ status: 409, body: { error } });
const invalid = (details: { field: string; issue: string }[]) => ({ status: 400, body: { error: "validation_failed", details } });
const sorted = (codes: readonly string[]) => [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

interface Actor {
  readonly userId: string;
  readonly employeeNumber: string;
  readonly token: string;
  readonly refreshToken: string;
}

type Assignment = { role: DefaultRoleCode; branchId?: string } | { roleId: string; branchId?: string };

// Employee management over real HTTP (AppModule, guards, filters), runtime identity erp_app, default roles provisioned.
describe("Users management API over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  let provisioning: TenantProvisioningService;
  let orgA: Org;
  let orgB: Org;
  const a: Record<string, Actor> = {};

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config);
    provisioning = new TenantProvisioningService(prisma, h.scope);
    await ensurePermissionCatalog(owner);
    orgA = await newOrg("Gestao A");
    orgB = await newOrg("Gestao B");

    a["OWNER"] = await actor(orgA, [{ role: "OWNER" }], [orgA.branchId, orgA.otherBranchId]);
    // Tenant-wide manager with access to MAIN only (never to OTHER).
    a["MANAGER"] = await actor(orgA, [{ role: "MANAGER" }], [orgA.branchId]);
    a["MANAGER2"] = await actor(orgA, [{ role: "MANAGER" }], [orgA.branchId]);
    a["ATTENDANT"] = await actor(orgA, [{ role: "ATTENDANT" }], [orgA.branchId]);
    a["KITCHEN"] = await actor(orgA, [{ role: "KITCHEN" }], [orgA.branchId]);
    a["B:OWNER"] = await actor(orgB, [{ role: "OWNER" }], [orgB.branchId]);
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  async function newOrg(name: string): Promise<Org> {
    const org = await seedOrg(owner, name);
    await h.tenants.run({ tenantId: org.tenantId }, () => provisioning.provisionDefaultRoles());
    return org;
  }

  async function roleIdOf(org: Org, code: string): Promise<string> {
    return (await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code } } })).id;
  }

  /** Custom role (not OWNER) with every OWNER permission: authority of an owner without being the "Proprietário". */
  async function superRole(org: Org): Promise<string> {
    const code = `SUPER${randomBytes(3).toString("hex").toUpperCase()}`;
    const role = await owner.role.create({ data: { tenantId: org.tenantId, code, name: "Super", status: RoleStatus.ACTIVE } });
    const permissions = await owner.permission.findMany({ where: { code: { in: [...DEFAULT_ROLE_PERMISSIONS.OWNER] } } });
    await owner.rolePermission.createMany({ data: permissions.map((p) => ({ tenantId: org.tenantId, roleId: role.id, permissionId: p.id })) });
    return role.id;
  }

  async function login(org: Org, employeeNumber: string, password = DEFAULT_PASSWORD) {
    return h.auth.login({ tenantId: org.tenantId }, { employeeNumber, password });
  }

  /** User with the given role assignments (tenant-wide unless `branchId`) and branch accesses, logged in. */
  async function actor(org: Org, assignments: readonly Assignment[], branches: readonly string[], status?: UserStatus): Promise<Actor> {
    const user = await seedUser(owner, org.tenantId);
    for (const branchId of branches) await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId } });
    for (const x of assignments) {
      const roleId = "roleId" in x ? x.roleId : await roleIdOf(org, x.role);
      await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId, branchId: x.branchId ?? null } });
    }
    const tokens = await login(org, user.employeeNumber);
    if (status) await owner.user.update({ where: { id: user.id }, data: { status, ...(status === UserStatus.DISABLED ? { disabledAt: new Date() } : {}) } });
    return { userId: user.id, employeeNumber: user.employeeNumber, token: tokens.accessToken, refreshToken: tokens.refreshToken };
  }

  function call(who: Actor, method: string, path: string, body?: unknown) {
    return http.request(path, { method, token: who.token, ...(body !== undefined ? { body } : {}) });
  }

  async function ok(who: Actor, method: string, path: string, body?: unknown): Promise<UserDto> {
    const res = await call(who, method, path, body);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(method === "POST" && path === "/users" ? 201 : 200);
    return res.body as UserDto;
  }

  async function auditOf(org: Org, targetUserId: string) {
    return owner.auditLog.findMany({ where: { tenantId: org.tenantId, resourceId: targetUserId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  }

  async function actions(org: Org, targetUserId: string): Promise<string[]> {
    return (await auditOf(org, targetUserId)).map((row) => row.action);
  }

  async function dbUser(id: string) {
    return owner.user.findUniqueOrThrow({ where: { id } });
  }

  /** Plain employee (no roles), logged in, for operations that only need a target. */
  const employee = (org: Org = orgA, branches: readonly string[] = [orgA.branchId]) => actor(org, [], branches);

  const managementRoutes = (id: string): [string, string, unknown][] => [
    ["POST", "/users", { name: "X", employeeNumber: `N${randomBytes(3).toString("hex")}`, temporaryPassword: TEMP_PASSWORD }],
    ["PATCH", `/users/${id}`, { name: "Novo" }],
    ["PUT", `/users/${id}/roles`, { roles: [] }],
    ["POST", `/users/${id}/deactivate`, undefined],
    ["POST", `/users/${id}/activate`, undefined],
    ["POST", `/users/${id}/reset-password`, { temporaryPassword: TEMP_PASSWORD }],
    ["POST", `/users/${id}/unlock`, undefined],
  ];

  describe("authentication, permission and tenant isolation", () => {
    it("requires a token on every route (401)", async () => {
      for (const [method, path, body] of [...managementRoutes(a["KITCHEN"]!.userId), ["GET", "/roles", undefined] as [string, string, unknown]]) {
        expect(await http.request(path, { method, ...(body !== undefined ? { body } : {}) }), `${method} ${path}`).toEqual({ status: 401, body: { error: "unauthenticated" } });
      }
    });

    it("requires user.manage: 403 for ATTENDANT and KITCHEN on every management route", async () => {
      const target = await employee();
      for (const who of ["ATTENDANT", "KITCHEN"]) {
        for (const [method, path, body] of managementRoutes(target.userId)) {
          expect(await call(a[who]!, method, path, body), `${who} ${method} ${path}`).toEqual(FORBIDDEN);
        }
      }
    });

    it("answers 404 for a user of another tenant, an unknown id and a non-UUID id on every route", async () => {
      const foreign = await employee(orgB, [orgB.branchId]);
      for (const id of [foreign.userId, randomUUID(), "not-a-uuid"]) {
        for (const [method, path, body] of managementRoutes(id).slice(1)) {
          expect(await call(a["OWNER"]!, method, path, body), `${method} ${path}`).toEqual(NOT_FOUND);
        }
      }
      expect((await dbUser(foreign.userId)).status).toBe(UserStatus.ACTIVE);
      expect(await actions(orgB, foreign.userId)).toEqual([]);
    });
  });

  describe("POST /users", () => {
    it("creates an ACTIVE user with a mandatory password change, no roles, no branches; login then requires the change", async () => {
      const employeeNumber = `NEW${randomBytes(3).toString("hex").toUpperCase()}`;
      const res = await call(a["MANAGER"]!, "POST", "/users", { name: "  Novo Caixa  ", employeeNumber: employeeNumber.toLowerCase(), temporaryPassword: TEMP_PASSWORD });
      expect(res.status).toBe(201);
      const dto = res.body as UserDto;
      expect(dto).toMatchObject({ name: "Novo Caixa", employeeNumber, status: "ACTIVE", mustChangePassword: true, roles: [] });
      expect(Object.keys(dto).sort()).toEqual(["createdAt", "employeeNumber", "id", "mustChangePassword", "name", "roles", "status", "updatedAt"]);
      expect(JSON.stringify(dto)).not.toMatch(/passwordHash|argon2|tenantId/);
      expect(JSON.stringify(dto)).not.toContain(TEMP_PASSWORD);
      expect(await owner.userBranchAccess.count({ where: { userId: dto.id } })).toBe(0);
      expect((await dbUser(dto.id)).passwordHash).toMatch(/^\$argon2id\$/);

      const tokens = await login(orgA, employeeNumber, TEMP_PASSWORD);
      expect(await http.request("/me", { token: tokens.accessToken })).toEqual({ status: 403, body: { error: "password_change_required" } });

      const audit = await auditOf(orgA, dto.id);
      expect(audit.filter((row) => row.action === "user.created")).toMatchObject([{ userId: a["MANAGER"]!.userId, resourceType: "user", metadata: null }]);
      expect(JSON.stringify(audit)).not.toContain(TEMP_PASSWORD);
    });

    it("rejects a duplicate employee number, also typed in lower case (409)", async () => {
      await ok(a["OWNER"]!, "POST", "/users", { name: "Caixa", employeeNumber: "CAIXA1", temporaryPassword: TEMP_PASSWORD });
      expect(await call(a["OWNER"]!, "POST", "/users", { name: "Outro", employeeNumber: "caixa1", temporaryPassword: TEMP_PASSWORD })).toEqual(conflict("employee_number_already_exists"));
      // Same number in another tenant is fine.
      await ok(a["B:OWNER"]!, "POST", "/users", { name: "Caixa B", employeeNumber: "CAIXA1", temporaryPassword: TEMP_PASSWORD });
    });

    it("turns a concurrent duplicate into 409, never 500", async () => {
      const body = { name: "Corrida", employeeNumber: `RACE${randomBytes(3).toString("hex").toUpperCase()}`, temporaryPassword: TEMP_PASSWORD };
      const results = await Promise.all([call(a["OWNER"]!, "POST", "/users", body), call(a["MANAGER"]!, "POST", "/users", body)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body).toEqual({ error: "employee_number_already_exists" });
    });

    it("validates the body: invalid employee number, short password, unknown fields", async () => {
      const base = { name: "X", employeeNumber: "OK1", temporaryPassword: TEMP_PASSWORD };
      expect(await call(a["OWNER"]!, "POST", "/users", { ...base, employeeNumber: "com espaço" })).toEqual(invalid([{ field: "employeeNumber", issue: "invalid_format" }]));
      expect(await call(a["OWNER"]!, "POST", "/users", { ...base, temporaryPassword: "curta" })).toEqual(invalid([{ field: "temporaryPassword", issue: "too_short" }]));
      expect(await call(a["OWNER"]!, "POST", "/users", { ...base, tenantId: orgB.tenantId, status: "LOCKED" })).toEqual(
        invalid([
          { field: "tenantId", issue: "unknown_field" },
          { field: "status", issue: "unknown_field" },
        ]),
      );
    });
  });

  describe("PATCH /users/:userId", () => {
    it("changes only the name; audits once; the same name is a no-op", async () => {
      const target = await employee();
      expect(await ok(a["MANAGER"]!, "PATCH", `/users/${target.userId}`, { name: "  Nome Novo " })).toMatchObject({ name: "Nome Novo", employeeNumber: target.employeeNumber });
      await ok(a["MANAGER"]!, "PATCH", `/users/${target.userId}`, { name: "Nome Novo" });
      expect(await actions(orgA, target.userId)).toEqual(["user.updated"]);
    });

    it("rejects employeeNumber (immutable) and any other field", async () => {
      const target = await employee();
      expect(await call(a["OWNER"]!, "PATCH", `/users/${target.userId}`, { name: "A", employeeNumber: "OUTRO" })).toEqual(invalid([{ field: "employeeNumber", issue: "unknown_field" }]));
      expect(await call(a["OWNER"]!, "PATCH", `/users/${target.userId}`, { name: "x".repeat(201) })).toEqual(invalid([{ field: "name", issue: "too_long" }]));
      expect((await dbUser(target.userId)).employeeNumber).toBe(target.employeeNumber);
    });
  });

  describe("authority (nobody manages above their own authority)", () => {
    it("the manager does not edit, deactivate, reset, unlock, re-role or activate the owner (403)", async () => {
      const ownerId = a["OWNER"]!.userId;
      for (const [method, path, body] of managementRoutes(ownerId).slice(1)) {
        expect(await call(a["MANAGER"]!, method, path, body), `${method} ${path}`).toEqual(FORBIDDEN);
      }
      expect(await actions(orgA, ownerId)).toEqual([]);
    });

    it("the manager assigns ATTENDANT and KITCHEN but never OWNER", async () => {
      const target = await employee();
      const roles = [
        { roleId: await roleIdOf(orgA, "ATTENDANT"), branchId: null },
        { roleId: await roleIdOf(orgA, "KITCHEN"), branchId: orgA.branchId },
      ];
      expect((await ok(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles })).roles.map((r) => [r.code, r.branch?.code ?? null])).toEqual([
        ["ATTENDANT", null],
        ["KITCHEN", "MAIN"],
      ]);
      expect(await call(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [...roles, { roleId: await roleIdOf(orgA, "OWNER"), branchId: null }] })).toEqual(FORBIDDEN);
    });

    // Product decision (10/11): the manager does not create nor promote anyone to Owner/Manager and does not manage
    // another administrator. Touching `user.manage` (target or role) requires `role.manage` in the tenant.
    it("the manager cannot assign or remove MANAGER nor manage another manager; the owner can", async () => {
      const target = await employee();
      const manager = { roleId: await roleIdOf(orgA, "MANAGER"), branchId: null };
      expect(await call(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [manager] })).toEqual(FORBIDDEN);
      expect((await ok(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [manager] })).roles.map((r) => r.code)).toEqual(["MANAGER"]);
      // Now the target is an administrator: every management action by the manager is 403.
      expect(await call(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [] })).toEqual(FORBIDDEN);
      expect(await call(a["MANAGER"]!, "PATCH", `/users/${target.userId}`, { name: "Outro nome" })).toEqual(FORBIDDEN);
      expect(await call(a["MANAGER"]!, "POST", `/users/${target.userId}/deactivate`)).toEqual(FORBIDDEN);
      expect(await call(a["MANAGER"]!, "POST", `/users/${target.userId}/unlock`)).toEqual(FORBIDDEN);
      expect(await call(a["MANAGER"]!, "POST", `/users/${target.userId}/reset-password`, { temporaryPassword: "Temporaria#2026" })).toEqual(FORBIDDEN);
      expect((await ok(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [] })).roles).toEqual([]);
      // Back to a plain employee: the manager manages it again.
      await ok(a["MANAGER"]!, "PATCH", `/users/${target.userId}`, { name: "Funcionario comum" });
    });

    it("a branch-scoped role at a branch where the actor has no user.manage (no access) is 403", async () => {
      const target = await employee(orgA, [orgA.branchId, orgA.otherBranchId]);
      const kitchen = await roleIdOf(orgA, "KITCHEN");
      expect(await call(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [{ roleId: kitchen, branchId: orgA.otherBranchId }] })).toEqual(FORBIDDEN);
      await ok(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [{ roleId: kitchen, branchId: orgA.otherBranchId }] });
      // Removing it is also a change at OTHER: still 403 for the manager.
      expect(await call(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [] })).toEqual(FORBIDDEN);
    });

    it("checks 404 before 403 before 409", async () => {
      expect(await call(a["MANAGER"]!, "POST", `/users/${randomUUID()}/deactivate`)).toEqual(NOT_FOUND);
      // The owner is the last owner (409 for someone allowed), but the manager gets 403 first.
      expect(await call(a["MANAGER"]!, "POST", `/users/${a["OWNER"]!.userId}/deactivate`)).toEqual(FORBIDDEN);
    });
  });

  describe("PUT /users/:userId/roles", () => {
    it("replaces the set (adds and removes in one transaction) and audits the ids that entered and left", async () => {
      const target = await employee(orgA, [orgA.branchId, orgA.otherBranchId]);
      const [attendant, kitchen] = [await roleIdOf(orgA, "ATTENDANT"), await roleIdOf(orgA, "KITCHEN")];
      await ok(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [{ roleId: attendant, branchId: null }, { roleId: kitchen, branchId: orgA.branchId }] });
      const dto = await ok(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, {
        roles: [
          { roleId: kitchen, branchId: orgA.branchId },
          { roleId: kitchen, branchId: orgA.otherBranchId },
        ],
      });
      expect(dto.roles.map((r) => [r.code, r.branch?.code ?? null])).toEqual([
        ["KITCHEN", "MAIN"],
        ["KITCHEN", "OTHER"],
      ]);
      // Same set again: no change, no audit.
      await ok(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [{ roleId: kitchen, branchId: orgA.otherBranchId }, { roleId: kitchen, branchId: orgA.branchId }] });

      const audit = (await auditOf(orgA, target.userId)).filter((row) => row.action === "user.roles_replaced");
      expect(audit.map((row) => row.metadata)).toEqual([
        { roles_added: [attendant, `${kitchen}:${orgA.branchId}`], roles_removed: [] },
        { roles_added: [`${kitchen}:${orgA.otherBranchId}`], roles_removed: [attendant] },
      ]);
      expect(audit.every((row) => row.userId === a["OWNER"]!.userId)).toBe(true);
    });

    it("an empty list removes every role", async () => {
      const target = await actor(orgA, [{ role: "ATTENDANT" }, { role: "KITCHEN", branchId: orgA.branchId }], [orgA.branchId]);
      expect((await ok(a["MANAGER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [] })).roles).toEqual([]);
      expect(await owner.userRole.count({ where: { userId: target.userId } })).toBe(0);
    });

    it("requires branch access for a scoped role (409 branch_access_required)", async () => {
      const target = await employee(orgA, [orgA.branchId]);
      expect(await call(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [{ roleId: await roleIdOf(orgA, "KITCHEN"), branchId: orgA.otherBranchId }] })).toEqual(
        conflict("branch_access_required"),
      );
    });

    it("refuses an entering role that is not ACTIVE (409 role_inactive) but keeps an existing inactive assignment", async () => {
      const inactive = (await owner.role.create({ data: { tenantId: orgA.tenantId, code: `OFF${randomBytes(3).toString("hex").toUpperCase()}`, name: "Off", status: RoleStatus.INACTIVE } })).id;
      const archived = (await owner.role.create({ data: { tenantId: orgA.tenantId, code: `ARC${randomBytes(3).toString("hex").toUpperCase()}`, name: "Arq", status: RoleStatus.ARCHIVED } })).id;
      const target = await employee();
      for (const roleId of [inactive, archived]) {
        expect(await call(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [{ roleId, branchId: null }] })).toEqual(conflict("role_inactive"));
      }
      const holder = await actor(orgA, [{ roleId: inactive }], [orgA.branchId]);
      const dto = await ok(a["OWNER"]!, "PUT", `/users/${holder.userId}/roles`, { roles: [{ roleId: inactive, branchId: null }, { roleId: await roleIdOf(orgA, "KITCHEN"), branchId: null }] });
      expect(dto.roles.map((r) => [r.roleId, r.status])).toEqual(expect.arrayContaining([[inactive, "INACTIVE"]]));
    });

    it("rejects a role of another tenant or an unknown role with 400 on the item", async () => {
      const target = await employee();
      const foreign = await roleIdOf(orgB, "KITCHEN");
      expect(
        await call(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, {
          roles: [
            { roleId: await roleIdOf(orgA, "KITCHEN"), branchId: null },
            { roleId: foreign, branchId: null },
            { roleId: randomUUID(), branchId: null },
          ],
        }),
      ).toEqual(
        invalid([
          { field: "roles[1].roleId", issue: "invalid_value" },
          { field: "roles[2].roleId", issue: "invalid_value" },
        ]),
      );
      expect(await owner.userRole.count({ where: { userId: target.userId } })).toBe(0);
    });

    it("validates repeated pairs and more than 50 items", async () => {
      const target = await employee();
      const kitchen = { roleId: await roleIdOf(orgA, "KITCHEN"), branchId: null };
      expect(await call(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: [kitchen, kitchen] })).toEqual(invalid([{ field: "roles[1]", issue: "invalid_value" }]));
      expect(await call(a["OWNER"]!, "PUT", `/users/${target.userId}/roles`, { roles: Array.from({ length: 51 }, () => kitchen) })).toEqual(invalid([{ field: "roles", issue: "too_many" }]));
    });
  });

  describe("last owner", () => {
    it("blocks deactivating the last ACTIVE tenant-wide owner and removing its OWNER role, also by the owner itself", async () => {
      const org = await newOrg("Ultimo Dono");
      const ownerRole = await roleIdOf(org, "OWNER");
      const sole = await actor(org, [{ role: "OWNER" }], [org.branchId]);
      const admin = await actor(org, [{ roleId: await superRole(org) }], [org.branchId]);
      // Owners that do not count: LOCKED, DISABLED, and OWNER scoped to a branch.
      await actor(org, [{ role: "OWNER" }], [org.branchId], UserStatus.LOCKED);
      await actor(org, [{ role: "OWNER" }], [org.branchId], UserStatus.DISABLED);
      await actor(org, [{ role: "OWNER", branchId: org.branchId }], [org.branchId]);

      expect(await call(admin, "POST", `/users/${sole.userId}/deactivate`)).toEqual(conflict("last_owner_required"));
      expect(await call(admin, "PUT", `/users/${sole.userId}/roles`, { roles: [] })).toEqual(conflict("last_owner_required"));
      expect(await call(sole, "PUT", `/users/${sole.userId}/roles`, { roles: [{ roleId: ownerRole, branchId: org.branchId }] })).toEqual(conflict("last_owner_required"));
      expect(await call(sole, "POST", `/users/${sole.userId}/deactivate`)).toEqual(conflict("cannot_target_self"));

      // With a second ACTIVE owner, the first one can go.
      const second = await actor(org, [], [org.branchId]);
      await ok(sole, "PUT", `/users/${second.userId}/roles`, { roles: [{ roleId: ownerRole, branchId: null }] });
      expect((await ok(admin, "PUT", `/users/${sole.userId}/roles`, { roles: [] })).roles).toEqual([]);
      expect(await call(admin, "POST", `/users/${second.userId}/deactivate`)).toEqual(conflict("last_owner_required"));
    });

    it("concurrent deactivations of the only two owners leave exactly one ACTIVE owner (lock)", async () => {
      for (let round = 0; round < 5; round++) {
        const org = await newOrg(`Corrida ${round}`);
        const o1 = await actor(org, [{ role: "OWNER" }], [org.branchId]);
        const o2 = await actor(org, [{ role: "OWNER" }], [org.branchId]);
        const admin = await actor(org, [{ roleId: await superRole(org) }], [org.branchId]);
        const results = await Promise.all([call(admin, "POST", `/users/${o1.userId}/deactivate`), call(admin, "POST", `/users/${o2.userId}/deactivate`)]);
        expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409]);
        expect(results.find((r) => r.status === 409)!.body).toEqual({ error: "last_owner_required" });
        expect(await owner.user.count({ where: { id: { in: [o1.userId, o2.userId] }, status: UserStatus.ACTIVE } })).toBe(1);
      }
    });

    it("deactivation racing with the removal of OWNER from the other owner leaves one ACTIVE owner", async () => {
      for (let round = 0; round < 5; round++) {
        const org = await newOrg(`Corrida roles ${round}`);
        const o1 = await actor(org, [{ role: "OWNER" }], [org.branchId]);
        const o2 = await actor(org, [{ role: "OWNER" }], [org.branchId]);
        const admin = await actor(org, [{ roleId: await superRole(org) }], [org.branchId]);
        const results = await Promise.all([call(admin, "POST", `/users/${o1.userId}/deactivate`), call(admin, "PUT", `/users/${o2.userId}/roles`, { roles: [] })]);
        expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409]);
        const ownerRole = await roleIdOf(org, "OWNER");
        const owners = await owner.user.count({ where: { tenantId: org.tenantId, status: UserStatus.ACTIVE, roles: { some: { roleId: ownerRole, branchId: null } } } });
        expect(owners, `round ${round}`).toBe(1);
      }
    });

    it("two owners deactivating each other in parallel: at least one stays ACTIVE", async () => {
      for (let round = 0; round < 5; round++) {
        const org = await newOrg(`Duelo ${round}`);
        const o1 = await actor(org, [{ role: "OWNER" }], [org.branchId]);
        const o2 = await actor(org, [{ role: "OWNER" }], [org.branchId]);
        const results = await Promise.all([call(o1, "POST", `/users/${o2.userId}/deactivate`), call(o2, "POST", `/users/${o1.userId}/deactivate`)]);
        // The loser is 409 (last owner), or 401/403 if its own deactivation committed before its request was checked.
        expect(results.filter((r) => r.status === 200), `round ${round}`).toHaveLength(1);
        expect(await owner.user.count({ where: { id: { in: [o1.userId, o2.userId] }, status: UserStatus.ACTIVE } })).toBe(1);
      }
    });
  });

  describe("POST /users/:userId/deactivate", () => {
    it("disables, sets disabledAt, revokes every session (refresh and access token stop working) and audits once", async () => {
      const target = await employee();
      const second = await login(orgA, target.employeeNumber);
      const dto = await ok(a["MANAGER"]!, "POST", `/users/${target.userId}/deactivate`);
      expect(dto.status).toBe("DISABLED");
      expect((await dbUser(target.userId)).disabledAt).toBeInstanceOf(Date);
      expect(await owner.session.count({ where: { userId: target.userId, revokedAt: null } })).toBe(0);
      await expect(h.auth.refresh(target.refreshToken)).rejects.toThrow();
      await expect(h.auth.refresh(second.refreshToken)).rejects.toThrow();
      expect((await http.request("/me", { token: target.token })).status).toBe(401);
      await expect(login(orgA, target.employeeNumber)).rejects.toThrow();

      // Idempotent: 200, no new audit row.
      expect((await ok(a["MANAGER"]!, "POST", `/users/${target.userId}/deactivate`)).status).toBe("DISABLED");
      const audit = await auditOf(orgA, target.userId);
      expect(audit.filter((row) => row.action === "user.deactivated")).toMatchObject([{ userId: a["MANAGER"]!.userId }]);
      expect(audit.filter((row) => row.action === "auth.sessions.revoked")).toMatchObject([{ metadata: { reason: "user_disabled", count: 2 } }]);
    });

    it("nobody deactivates themselves (409 cannot_target_self)", async () => {
      expect(await call(a["MANAGER"]!, "POST", `/users/${a["MANAGER"]!.userId}/deactivate`)).toEqual(conflict("cannot_target_self"));
    });

    it("refuses a user with an open cash session (409); after the cash is closed, it works", async () => {
      const operator = await actor(orgA, [{ role: "ATTENDANT" }], [orgA.branchId]);
      const cash = `/branches/${orgA.branchId}/cash-sessions`;
      const opened = await call(operator, "POST", cash, { openingAmount: "10.00" });
      expect(opened.status).toBe(201);
      expect(await call(a["MANAGER"]!, "POST", `/users/${operator.userId}/deactivate`)).toEqual(conflict("user_has_open_cash_session"));
      expect((await dbUser(operator.userId)).status).toBe(UserStatus.ACTIVE);
      expect((await call(operator, "POST", `${cash}/${(opened.body as { id: string }).id}/close`, { countedCash: "10.00" })).status).toBe(200);
      expect((await ok(a["MANAGER"]!, "POST", `/users/${operator.userId}/deactivate`)).status).toBe("DISABLED");
    });

    it("the manager deactivates neither another manager nor the owner; the owner deactivates the manager", async () => {
      const other = await actor(orgA, [{ role: "MANAGER" }], [orgA.branchId]);
      expect(await call(a["MANAGER"]!, "POST", `/users/${other.userId}/deactivate`)).toEqual(FORBIDDEN);
      expect((await ok(a["OWNER"]!, "POST", `/users/${other.userId}/deactivate`)).status).toBe("DISABLED");
      expect(await call(a["MANAGER"]!, "POST", `/users/${a["OWNER"]!.userId}/deactivate`)).toEqual(FORBIDDEN);
    });
  });

  describe("POST /users/:userId/activate", () => {
    it("DISABLED -> ACTIVE (clears disabledAt), the user logs in again; idempotent without audit", async () => {
      const target = await employee();
      await ok(a["OWNER"]!, "POST", `/users/${target.userId}/deactivate`);
      await expect(login(orgA, target.employeeNumber)).rejects.toThrow();
      expect((await ok(a["OWNER"]!, "POST", `/users/${target.userId}/activate`)).status).toBe("ACTIVE");
      expect((await dbUser(target.userId)).disabledAt).toBeNull();
      const tokens = await login(orgA, target.employeeNumber);
      expect((await http.request("/me", { token: tokens.accessToken })).status).toBe(200);
      await ok(a["OWNER"]!, "POST", `/users/${target.userId}/activate`);
      expect((await actions(orgA, target.userId)).filter((x) => x === "user.activated")).toHaveLength(1);
    });

    it("keeps LOCKED as LOCKED (no change, no audit)", async () => {
      const target = await actor(orgA, [], [orgA.branchId], UserStatus.LOCKED);
      expect((await ok(a["OWNER"]!, "POST", `/users/${target.userId}/activate`)).status).toBe("LOCKED");
      expect(await actions(orgA, target.userId)).toEqual([]);
    });
  });

  describe("POST /users/:userId/reset-password", () => {
    it("unlocks LOCKED and the temporary lock, requires a password change, revokes sessions; the password is never stored or audited", async () => {
      const target = await employee();
      await owner.user.update({ where: { id: target.userId }, data: { status: UserStatus.LOCKED, failedLoginAttempts: 4, lockedUntil: new Date(Date.now() + 3_600_000) } });
      const password = `Reset-${randomBytes(6).toString("hex")}`;
      const dto = await ok(a["MANAGER"]!, "POST", `/users/${target.userId}/reset-password`, { temporaryPassword: password });
      expect(dto).toMatchObject({ status: "ACTIVE", mustChangePassword: true });
      expect(await dbUser(target.userId)).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true });
      expect(await owner.session.count({ where: { userId: target.userId, revokedAt: null } })).toBe(0);
      await expect(h.auth.refresh(target.refreshToken)).rejects.toThrow();
      await expect(login(orgA, target.employeeNumber)).rejects.toThrow(); // old password
      const tokens = await login(orgA, target.employeeNumber, password);
      expect(await http.request("/me", { token: tokens.accessToken })).toEqual({ status: 403, body: { error: "password_change_required" } });

      const audit = await auditOf(orgA, target.userId);
      expect(audit.filter((row) => row.action === "auth.password.reset")).toMatchObject([{ userId: a["MANAGER"]!.userId }]);
      expect(audit.filter((row) => row.action === "auth.sessions.revoked")).toMatchObject([{ metadata: { reason: "password_reset" } }]);
      const json = JSON.stringify(await owner.auditLog.findMany({ where: { tenantId: orgA.tenantId } }));
      expect(json).not.toContain(password);
      expect(json).not.toContain((await dbUser(target.userId)).passwordHash);
    });

    it("keeps DISABLED as DISABLED (password still changes)", async () => {
      const target = await employee();
      await ok(a["OWNER"]!, "POST", `/users/${target.userId}/deactivate`);
      const before = (await dbUser(target.userId)).passwordHash;
      expect((await ok(a["OWNER"]!, "POST", `/users/${target.userId}/reset-password`, { temporaryPassword: TEMP_PASSWORD })).status).toBe("DISABLED");
      expect((await dbUser(target.userId)).passwordHash).not.toBe(before);
      await expect(login(orgA, target.employeeNumber, TEMP_PASSWORD)).rejects.toThrow();
    });

    it("never resets the actor's own password (409) and validates the policy (400)", async () => {
      expect(await call(a["MANAGER"]!, "POST", `/users/${a["MANAGER"]!.userId}/reset-password`, { temporaryPassword: TEMP_PASSWORD })).toEqual(conflict("cannot_target_self"));
      const target = await employee();
      expect(await call(a["MANAGER"]!, "POST", `/users/${target.userId}/reset-password`, { temporaryPassword: "curta" })).toEqual(
        invalid([{ field: "temporaryPassword", issue: "too_short" }]),
      );
    });
  });

  describe("POST /users/:userId/unlock", () => {
    it("clears the temporary lock without changing the password or dropping the session; idempotent", async () => {
      const target = await employee();
      await owner.user.update({ where: { id: target.userId }, data: { failedLoginAttempts: 3, lockedUntil: new Date(Date.now() + 3_600_000) } });
      const before = (await dbUser(target.userId)).passwordHash;
      expect((await ok(a["MANAGER"]!, "POST", `/users/${target.userId}/unlock`)).status).toBe("ACTIVE");
      expect(await dbUser(target.userId)).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null, passwordHash: before });
      expect((await http.request("/me", { token: target.token })).status).toBe(200);
      await expect(h.auth.refresh(target.refreshToken)).resolves.toMatchObject({ userId: target.userId });
      await ok(a["MANAGER"]!, "POST", `/users/${target.userId}/unlock`);
      expect(await actions(orgA, target.userId)).toEqual(["user.unlocked"]);
    });

    it("LOCKED -> ACTIVE, then the user logs in", async () => {
      const target = await actor(orgA, [], [orgA.branchId], UserStatus.LOCKED);
      await expect(login(orgA, target.employeeNumber)).rejects.toThrow();
      expect((await ok(a["OWNER"]!, "POST", `/users/${target.userId}/unlock`)).status).toBe("ACTIVE");
      expect((await login(orgA, target.employeeNumber)).userId).toBe(target.userId);
    });
  });

  describe("GET /roles", () => {
    it("lists every role of the tenant: system roles first, then by code; permissions sorted; ARCHIVED shown as INACTIVE", async () => {
      const org = await newOrg("Roles");
      const viewer = await actor(org, [{ role: "MANAGER" }], [org.branchId]);
      await owner.role.create({ data: { tenantId: org.tenantId, code: "ZCUSTOM", name: "Custom", description: "Desc", status: RoleStatus.ACTIVE } });
      await owner.role.create({ data: { tenantId: org.tenantId, code: "ACUSTOM", name: "Arquivada", status: RoleStatus.ARCHIVED } });
      const res = await call(viewer, "GET", "/roles");
      expect(res.status).toBe(200);
      const roles = res.body as RoleDto[];
      expect(roles.map((r) => [r.code, r.isSystem, r.status])).toEqual([
        ["ATTENDANT", true, "ACTIVE"],
        ["KITCHEN", true, "ACTIVE"],
        ["MANAGER", true, "ACTIVE"],
        ["OWNER", true, "ACTIVE"],
        ["ACUSTOM", false, "INACTIVE"],
        ["ZCUSTOM", false, "ACTIVE"],
      ]);
      for (const role of roles) expect(Object.keys(role).sort()).toEqual(["code", "description", "id", "isSystem", "name", "permissions", "status"]);
      for (const code of ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"] as const) {
        expect(roles.find((r) => r.code === code)!.permissions, code).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS[code]));
      }
      expect(roles.find((r) => r.code === "ZCUSTOM")).toMatchObject({ name: "Custom", description: "Desc", permissions: [] });
      expect(JSON.stringify(roles)).not.toMatch(/tenantId|tenant_id/);
    });

    it("requires role.read (403 for ATTENDANT and KITCHEN) and never shows another tenant's roles", async () => {
      expect(await call(a["ATTENDANT"]!, "GET", "/roles")).toEqual(FORBIDDEN);
      expect(await call(a["KITCHEN"]!, "GET", "/roles")).toEqual(FORBIDDEN);
      const ids = ((await call(a["OWNER"]!, "GET", "/roles")).body as RoleDto[]).map((r) => r.id);
      expect(ids).toContain(await roleIdOf(orgA, "OWNER"));
      expect(ids).not.toContain(await roleIdOf(orgB, "OWNER"));
    });
  });
});
