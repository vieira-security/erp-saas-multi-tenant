import { randomBytes, randomUUID } from "node:crypto";
import type { MeDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BranchStatus, CompanyStatus, RoleStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { AuthorizationService, TENANT_SCOPE, branchScope } from "../../src/authorization/authorization.service.js";
import { DEFAULT_ROLE_PERMISSIONS, type DefaultRoleCode } from "../../src/tenants/default-roles.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { DEFAULT_PASSWORD, authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

const ROLES = ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"] as const;
const sorted = (codes: readonly string[]) => [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

interface Actor {
  readonly userId: string;
  readonly employeeNumber: string;
  readonly token: string;
}

// KAN-52: GET /me over real HTTP (AppModule, AuthGuard, filters), runtime identity erp_app, default roles provisioned.
describe("GET /me over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  let authz: AuthorizationService;
  let orgA: Org;
  let orgB: Org;
  /** Branches of org A, in creation order: MAIN, OTHER (seedOrg), OLD (INACTIVE), FROZEN (ACTIVE, under an INACTIVE company). */
  let oldBranchId: string;
  let frozenBranchId: string;
  let frozenCompanyId: string;
  const actors: Record<string, Actor> = {};

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    authz = new AuthorizationService(prisma, h.scope);
    http = await startHttpApp(prisma, config);
    await ensurePermissionCatalog(owner);
    orgA = await seedOrg(owner, "Me A");
    orgB = await seedOrg(owner, "Me B");
    const provisioning = new TenantProvisioningService(prisma, h.scope);
    for (const org of [orgA, orgB]) await h.tenants.run({ tenantId: org.tenantId }, () => provisioning.provisionDefaultRoles());

    oldBranchId = (
      await owner.branch.create({
        data: { tenantId: orgA.tenantId, companyId: orgA.companyId, name: "Old", code: "OLD", status: BranchStatus.INACTIVE, timezone: "America/Sao_Paulo" },
      })
    ).id;
    frozenCompanyId = (
      await owner.company.create({
        data: { tenantId: orgA.tenantId, legalName: "Frozen Ltda", tradeName: "Frozen", cnpj: "12345678000195", status: CompanyStatus.INACTIVE, timezone: "America/Sao_Paulo" },
      })
    ).id;
    frozenBranchId = (
      await owner.branch.create({
        data: { tenantId: orgA.tenantId, companyId: frozenCompanyId, name: "Frozen", code: "FROZEN", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
      })
    ).id;

    // Every default role tenant-wide, with access to MAIN, OLD and FROZEN — never to OTHER.
    for (const role of ROLES) actors[role] = await actor(orgA, [{ role }], [orgA.branchId, oldBranchId, frozenBranchId]);
    // MANAGER only at OTHER (branch-scoped role), plus access to MAIN without any role there.
    actors["SCOPED"] = await actor(orgA, [{ role: "MANAGER", branchId: orgA.otherBranchId }], [orgA.branchId, orgA.otherBranchId]);
    // ATTENDANT tenant-wide + MANAGER scoped to OTHER.
    actors["MIXED"] = await actor(orgA, [{ role: "ATTENDANT" }, { role: "MANAGER", branchId: orgA.otherBranchId }], [orgA.branchId, orgA.otherBranchId]);
    // KITCHEN (active) + an INACTIVE custom role carrying every permission: only KITCHEN counts.
    const inactive = await owner.role.create({ data: { tenantId: orgA.tenantId, code: `OFF${randomBytes(3).toString("hex").toUpperCase()}`, name: "Off", status: RoleStatus.INACTIVE } });
    const everyPermission = await owner.permission.findMany({ where: { code: { in: [...DEFAULT_ROLE_PERMISSIONS.OWNER] } } });
    await owner.rolePermission.createMany({ data: everyPermission.map((p) => ({ tenantId: orgA.tenantId, roleId: inactive.id, permissionId: p.id })) });
    actors["INACTIVE_ROLE"] = await actor(orgA, [{ role: "KITCHEN" }, { roleId: inactive.id }], [orgA.branchId]);
    actors["NO_ROLE"] = await actor(orgA, [], [orgA.branchId]);
    actors["NOTHING"] = await actor(orgA, [], []);
    actors["B:OWNER"] = await actor(orgB, [{ role: "OWNER" }], [orgB.branchId]);
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  async function roleIdOf(org: Org, code: DefaultRoleCode): Promise<string> {
    return (await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code } } })).id;
  }

  /** User with the given role assignments (tenant-wide unless `branchId`) and access to `branches`, logged in. */
  async function actor(
    org: Org,
    assignments: readonly ({ role: DefaultRoleCode; branchId?: string } | { roleId: string; branchId?: string })[],
    branches: readonly string[],
    extra: { mustChangePassword?: boolean } = {},
  ): Promise<Actor> {
    const user = await seedUser(owner, org.tenantId, extra);
    for (const branchId of branches) await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId } });
    for (const a of assignments) {
      const roleId = "roleId" in a ? a.roleId : await roleIdOf(org, a.role);
      await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId, branchId: a.branchId ?? null } });
    }
    const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: DEFAULT_PASSWORD });
    return { userId: user.id, employeeNumber: user.employeeNumber, token: tokens.accessToken };
  }

  async function me(key: string): Promise<MeDto> {
    const res = await http.request("/me", { token: actors[key]!.token });
    expect(res.status, key).toBe(200);
    return res.body as MeDto;
  }

  const branchIds = (dto: MeDto) => dto.branches.map((b) => b.id);
  const branch = (dto: MeDto, id: string) => dto.branches.find((b) => b.id === id)!;

  it("requires authentication (401 without or with an invalid token)", async () => {
    expect(await http.request("/me")).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect(await http.request("/me", { token: "not-a-token" })).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("answers 403 password_change_required while the password must be changed (no exception for /me)", async () => {
    const pending = await actor(orgA, [{ role: "OWNER" }], [orgA.branchId], { mustChangePassword: true });
    expect(await http.request("/me", { token: pending.token })).toEqual({ status: 403, body: { error: "password_change_required" } });
  });

  it("returns exactly the MeDto shape, from the token's tenant, without tenantId", async () => {
    const dto = await me("ATTENDANT");
    expect(Object.keys(dto).sort()).toEqual(["branches", "organization", "permissions", "user"]);
    expect(dto.user).toEqual({ id: actors["ATTENDANT"]!.userId, name: `User ${actors["ATTENDANT"]!.employeeNumber}`, employeeNumber: actors["ATTENDANT"]!.employeeNumber, mustChangePassword: false });
    expect(dto.organization).toEqual({ id: orgA.tenantId, name: "Me A", status: "ACTIVE", loginCode: orgA.loginCode });
    expect(Object.keys(dto.branches[0]!).sort()).toEqual(["code", "companyId", "id", "name", "operable", "permissions", "status"]);
    expect(JSON.stringify(dto)).not.toMatch(/tenantId|tenant_id|passwordHash/);

    const b = await me("B:OWNER");
    expect(b.organization.id).toBe(orgB.tenantId);
    expect(branchIds(b)).toEqual([orgB.branchId]);
  });

  it("gives each default role its matrix in the tenant scope and in every accessible branch, sorted by code", async () => {
    for (const role of ROLES) {
      const dto = await me(role);
      const expected = sorted(DEFAULT_ROLE_PERMISSIONS[role]);
      expect(dto.permissions, role).toEqual(expected);
      expect(branchIds(dto), role).toEqual([orgA.branchId, oldBranchId, frozenBranchId]); // OTHER (no access) is absent
      for (const b of dto.branches) expect(b.permissions, `${role}@${b.code}`).toEqual(expected);
    }
  });

  it("lists every accessible branch in creation order with operable only for ACTIVE branch + ACTIVE company", async () => {
    const dto = await me("OWNER");
    expect(dto.branches.map((b) => [b.code, b.status, b.operable, b.companyId])).toEqual([
      ["MAIN", "ACTIVE", true, orgA.companyId],
      ["OLD", "INACTIVE", false, orgA.companyId],
      ["FROZEN", "ACTIVE", false, frozenCompanyId],
    ]);
    // /me/branches keeps its M3 meaning: only the operable ones.
    const short = await http.request("/me/branches", { token: actors["OWNER"]!.token });
    expect((short.body as { id: string }[]).map((b) => b.id)).toEqual([orgA.branchId]);
  });

  it("counts a branch-scoped role only in that branch, never in the tenant scope", async () => {
    const dto = await me("SCOPED");
    expect(dto.permissions).toEqual([]);
    expect(branchIds(dto)).toEqual([orgA.branchId, orgA.otherBranchId]);
    expect(branch(dto, orgA.branchId).permissions).toEqual([]);
    expect(branch(dto, orgA.otherBranchId).permissions).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS.MANAGER));

    const mixed = await me("MIXED");
    expect(mixed.permissions).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS.ATTENDANT));
    expect(branch(mixed, orgA.branchId).permissions).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS.ATTENDANT));
    expect(branch(mixed, orgA.otherBranchId).permissions).toEqual(sorted([...new Set([...DEFAULT_ROLE_PERMISSIONS.ATTENDANT, ...DEFAULT_ROLE_PERMISSIONS.MANAGER])]));
  });

  it("ignores INACTIVE roles and returns empty lists for a user without roles", async () => {
    const inactive = await me("INACTIVE_ROLE");
    expect(inactive.permissions).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS.KITCHEN));
    expect(branch(inactive, orgA.branchId).permissions).toEqual(sorted(DEFAULT_ROLE_PERMISSIONS.KITCHEN));

    const none = await me("NO_ROLE");
    expect(none.permissions).toEqual([]);
    expect(none.branches.map((b) => [b.id, b.permissions])).toEqual([[orgA.branchId, []]]);

    const nothing = await me("NOTHING");
    expect(nothing).toMatchObject({ permissions: [], branches: [] });
  });

  it("matches AuthorizationService for every actor, in the tenant scope and in every branch of the tenant", async () => {
    const tenantBranches = [orgA.branchId, orgA.otherBranchId, oldBranchId, frozenBranchId, randomUUID()];
    for (const [key, a] of Object.entries(actors)) {
      if (key.startsWith("B:")) continue;
      const dto = await me(key);
      await h.tenants.run({ tenantId: orgA.tenantId }, async () => {
        expect(dto.permissions, key).toEqual(sorted([...(await authz.getEffectivePermissions(a.userId, TENANT_SCOPE))]));
        for (const branchId of tenantBranches) {
          const expected = sorted([...(await authz.getEffectivePermissions(a.userId, branchScope(branchId)))]);
          const listed = dto.branches.find((b) => b.id === branchId);
          if (listed) expect(listed.permissions, `${key}@${branchId}`).toEqual(expected);
          else expect(expected, `${key}@${branchId} (not listed)`).toEqual([]);
        }
      });
    }
  });
});
