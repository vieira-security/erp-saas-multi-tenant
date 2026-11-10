import { randomBytes } from "node:crypto";
import { Controller, Get, Param } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RoleStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { AuthorizationService, TENANT_SCOPE, branchScope } from "../../src/authorization/authorization.service.js";
import { RequireBranchPermissions, RequirePermissions } from "../../src/authorization/permission.guard.js";
import { TenantContextMissingError } from "../../src/tenancy/tenant-context.js";
import { authHarness, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

// Unique per run: the permission catalog is global and shared by parallel test files.
const MOD = `authz_${randomBytes(3).toString("hex")}`;
const READ = `${MOD}.read`;
const WRITE = `${MOD}.write`;
const ADMIN = `${MOD}.admin`;

/** A method-level requirement never replaces the class-level one: both apply. */
@Controller("authz-class")
@RequirePermissions(ADMIN)
class AuthzClassController {
  @Get("read")
  @RequirePermissions(READ)
  read(): unknown {
    return { ok: true };
  }
}

@Controller("authz-probe")
class AuthzProbeController {
  @Get("read")
  @RequirePermissions(READ)
  read(): unknown {
    return { ok: true };
  }

  @Get("read-admin")
  @RequirePermissions(READ, ADMIN)
  readAdmin(): unknown {
    return { ok: true };
  }

  @Get("branches/:branchId/write")
  @RequireBranchPermissions("branchId", WRITE)
  write(@Param("branchId") branchId: string): unknown {
    return { branchId };
  }
}

describe("authorization (PostgreSQL, as erp_app)", () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let authz: AuthorizationService;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;
  const perm: Record<string, string> = {};

  beforeAll(async () => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(app, config);
    authz = new AuthorizationService(app, h.scope);
    http = await startHttpApp(createPrismaClient(inject("appDatabaseUrl")), config, [AuthzProbeController, AuthzClassController]);
    for (const code of [READ, WRITE, ADMIN]) perm[code] = (await owner.permission.create({ data: { code, module: MOD, description: "Teste" } })).id;
    orgA = await seedOrg(owner, "Authz A");
    orgB = await seedOrg(owner, "Authz B");
  });

  afterAll(async () => {
    await http?.close();
    await app.$disconnect();
    await owner.$disconnect();
  });

  async function role(org: Org, codes: string[], status: RoleStatus = RoleStatus.ACTIVE): Promise<string> {
    const created = await owner.role.create({
      data: { tenantId: org.tenantId, code: `R${randomBytes(4).toString("hex")}`, name: "Role", status },
    });
    for (const code of codes) await owner.rolePermission.create({ data: { tenantId: org.tenantId, roleId: created.id, permissionId: perm[code]! } });
    return created.id;
  }

  async function assign(org: Org, userId: string, roleId: string, branchId: string | null = null): Promise<void> {
    if (branchId) {
      await owner.userBranchAccess.upsert({
        where: { tenantId_userId_branchId: { tenantId: org.tenantId, userId, branchId } },
        create: { tenantId: org.tenantId, userId, branchId },
        update: {},
      });
    }
    await owner.userRole.create({ data: { tenantId: org.tenantId, userId, roleId, branchId } });
  }

  const inTenant = <T>(org: Org, fn: () => Promise<T>) => h.tenants.run({ tenantId: org.tenantId }, fn);
  const effective = async (org: Org, userId: string, scope = TENANT_SCOPE) => [...(await inTenant(org, () => authz.getEffectivePermissions(userId, scope)))].sort();

  async function grantAccess(org: Org, userId: string, branchId: string): Promise<void> {
    await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId, branchId } });
  }

  it("a tenant-wide role grants in the tenant scope, but in a branch only with UserBranchAccess to it", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await assign(orgA, user.id, await role(orgA, [READ, WRITE]));
    expect(await effective(orgA, user.id)).toEqual([READ, WRITE].sort());
    // The role says WHAT; UserBranchAccess says WHERE. No access to the branch = nothing there.
    expect(await effective(orgA, user.id, branchScope(orgA.branchId))).toEqual([]);
    expect(await effective(orgA, user.id, branchScope(orgA.otherBranchId))).toEqual([]);
    await grantAccess(orgA, user.id, orgA.branchId);
    expect(await effective(orgA, user.id, branchScope(orgA.branchId))).toEqual([READ, WRITE].sort());
    expect(await effective(orgA, user.id, branchScope(orgA.otherBranchId))).toEqual([]);
    // Revoking the access removes the branch permissions immediately (no cache).
    await owner.userBranchAccess.deleteMany({ where: { tenantId: orgA.tenantId, userId: user.id, branchId: orgA.branchId } });
    expect(await effective(orgA, user.id, branchScope(orgA.branchId))).toEqual([]);
  });

  it("a branch-scoped role grants only in its branch, never globally", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await assign(orgA, user.id, await role(orgA, [WRITE]), orgA.branchId); // creates the access to branchId
    await assign(orgA, user.id, await role(orgA, [READ]));
    expect(await effective(orgA, user.id)).toEqual([READ]);
    expect(await effective(orgA, user.id, branchScope(orgA.branchId))).toEqual([READ, WRITE].sort());
    expect(await effective(orgA, user.id, branchScope(orgA.otherBranchId))).toEqual([]); // no access there
    await grantAccess(orgA, user.id, orgA.otherBranchId);
    expect(await effective(orgA, user.id, branchScope(orgA.otherBranchId))).toEqual([READ]); // tenant-wide only
  });

  it("duplicate grants (same role global + branch, same permission via two roles) collapse into one permission", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const r1 = await role(orgA, [READ, WRITE]);
    await assign(orgA, user.id, r1);
    await assign(orgA, user.id, r1, orgA.branchId);
    await assign(orgA, user.id, await role(orgA, [READ]), orgA.branchId);
    expect(await effective(orgA, user.id, branchScope(orgA.branchId))).toEqual([READ, WRITE].sort());
  });

  it("INACTIVE and ARCHIVED roles grant nothing", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await assign(orgA, user.id, await role(orgA, [READ], RoleStatus.INACTIVE));
    await assign(orgA, user.id, await role(orgA, [WRITE], RoleStatus.ARCHIVED), orgA.branchId);
    expect(await effective(orgA, user.id)).toEqual([]);
    expect(await effective(orgA, user.id, branchScope(orgA.branchId))).toEqual([]);
  });

  it("DISABLED and LOCKED users have no permission at all", async () => {
    for (const status of [UserStatus.DISABLED, UserStatus.LOCKED]) {
      const user = await seedUser(owner, orgA.tenantId);
      await assign(orgA, user.id, await role(orgA, [READ]));
      expect(await effective(orgA, user.id)).toEqual([READ]);
      await owner.user.update({ where: { id: user.id }, data: { status } });
      expect(await effective(orgA, user.id)).toEqual([]);
    }
  });

  it("nothing from another tenant ever grants: user, role or branch of tenant B", async () => {
    const userA = await seedUser(owner, orgA.tenantId);
    const userB = await seedUser(owner, orgB.tenantId);
    await assign(orgB, userB.id, await role(orgB, [READ, WRITE, ADMIN]));
    await assign(orgB, userB.id, await role(orgB, [WRITE]), orgB.branchId);
    await assign(orgA, userA.id, await role(orgA, [READ]));

    expect(await effective(orgA, userB.id)).toEqual([]); // B's user evaluated in A
    expect(await effective(orgB, userA.id)).toEqual([]); // A's user evaluated in B
    expect(await effective(orgA, userA.id, branchScope(orgB.branchId))).toEqual([]); // B's branch from A's context
    expect(await effective(orgA, userB.id, branchScope(orgB.branchId))).toEqual([]);
    expect(await effective(orgA, userA.id)).toEqual([READ]);
  });

  it("unknown or malformed branch ids and user ids grant nothing", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await assign(orgA, user.id, await role(orgA, [READ]));
    for (const branchId of ["0199ffff-0000-7000-8000-000000000000", "not-a-uuid", ""]) {
      expect(await effective(orgA, user.id, branchScope(branchId)), branchId).toEqual([]);
    }
    expect(await effective(orgA, "not-a-uuid")).toEqual([]);
  });

  it("hasPermission / hasAllPermissions / hasAnyPermission", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await assign(orgA, user.id, await role(orgA, [READ]));
    await inTenant(orgA, async () => {
      expect(await authz.hasPermission(user.id, READ)).toBe(true);
      expect(await authz.hasPermission(user.id, WRITE)).toBe(false);
      expect(await authz.hasAllPermissions(user.id, [READ, WRITE])).toBe(false);
      expect(await authz.hasAllPermissions(user.id, [READ])).toBe(true);
      expect(await authz.hasAllPermissions(user.id, [])).toBe(true);
      expect(await authz.hasAnyPermission(user.id, [WRITE, READ])).toBe(true);
      expect(await authz.hasAnyPermission(user.id, [])).toBe(false);
    });
  });

  it("requires a tenant context", async () => {
    await expect(authz.getEffectivePermissions("0199ffff-0000-7000-8000-000000000000")).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  describe("PermissionGuard over HTTP", () => {
    async function login(org: Org, userId: string, employeeNumber: string) {
      const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber, password: "Senha-Correta-123" });
      expect(tokens.userId).toBe(userId);
      return tokens.accessToken;
    }

    it("401 without authentication, 403 without the permission, 200 with it; re-evaluated on every request", async () => {
      expect(await http.request("/authz-probe/read")).toEqual({ status: 401, body: { error: "unauthenticated" } });
      const user = await seedUser(owner, orgA.tenantId);
      const token = await login(orgA, user.id, user.employeeNumber);
      expect(await http.request("/authz-probe/read", { token })).toEqual({ status: 403, body: { error: "forbidden" } });

      const roleId = await role(orgA, [READ]);
      await assign(orgA, user.id, roleId);
      expect(await http.request("/authz-probe/read", { token })).toEqual({ status: 200, body: { ok: true } });
      expect((await http.request("/authz-probe/read-admin", { token })).status).toBe(403); // all permissions required

      await owner.role.update({ where: { id: roleId }, data: { status: RoleStatus.INACTIVE } });
      expect((await http.request("/authz-probe/read", { token })).status).toBe(403); // no cache, no permissions in the JWT
    });

    it("branch-scoped routes: allowed only in the branch the role covers, never in another tenant's branch", async () => {
      const user = await seedUser(owner, orgA.tenantId);
      await assign(orgA, user.id, await role(orgA, [WRITE]), orgA.branchId);
      const token = await login(orgA, user.id, user.employeeNumber);
      expect(await http.request(`/authz-probe/branches/${orgA.branchId}/write`, { token })).toEqual({ status: 200, body: { branchId: orgA.branchId } });
      expect((await http.request(`/authz-probe/branches/${orgA.otherBranchId}/write`, { token })).status).toBe(403);
      expect((await http.request(`/authz-probe/branches/${orgB.branchId}/write`, { token })).status).toBe(403);
      expect((await http.request(`/authz-probe/branches/not-a-uuid/write`, { token })).status).toBe(403);

      // Tenant-wide role in tenant B gives B's user nothing on A's branches (B's token is scoped to B).
      const userB = await seedUser(owner, orgB.tenantId);
      await assign(orgB, userB.id, await role(orgB, [WRITE]));
      const tokenB = await login(orgB, userB.id, userB.employeeNumber);
      expect((await http.request(`/authz-probe/branches/${orgA.branchId}/write`, { token: tokenB })).status).toBe(403);
      // Tenant-wide role without UserBranchAccess: still 403 in its own tenant's branch.
      expect((await http.request(`/authz-probe/branches/${orgB.branchId}/write`, { token: tokenB })).status).toBe(403);
      await grantAccess(orgB, userB.id, orgB.branchId);
      expect((await http.request(`/authz-probe/branches/${orgB.branchId}/write`, { token: tokenB })).status).toBe(200);
      expect((await http.request(`/authz-probe/branches/${orgB.otherBranchId}/write`, { token: tokenB })).status).toBe(403);
    });
  });

  it("class and method permission requirements both apply (a method cannot weaken its class)", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const readRole = await role(orgA, [READ]);
    await assign(orgA, user.id, readRole);
    const { accessToken: token } = await h.auth.login({ tenantId: orgA.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123" });
    expect((await http.request("/authz-class/read", { token })).status).toBe(403);
    await assign(orgA, user.id, await role(orgA, [ADMIN]));
    expect((await http.request("/authz-class/read", { token })).status).toBe(200);
  });

  it("rejects invalid permission codes when the decorator is applied", () => {
    expect(() => RequirePermissions("Not Valid")).toThrow();
    expect(() => RequirePermissions()).toThrow();
    expect(() => RequireBranchPermissions("branchId", "single")).toThrow();
  });
});
