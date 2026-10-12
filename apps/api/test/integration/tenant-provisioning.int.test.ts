import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RoleStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { TenantContextMissingError, TenantContextService } from "../../src/tenancy/tenant-context.js";
import { TenantScope } from "../../src/tenancy/tenant-scope.js";
import { DEFAULT_ROLE_PERMISSIONS, type RolePermissionMatrix } from "../../src/tenants/default-roles.js";
import { TenantProvisioningService, UnknownPermissionInMatrixError } from "../../src/tenants/tenant-provisioning.service.js";
import { seedOrg, type Org } from "./auth-fixtures.js";

// M2.11: idempotent provisioning of the default roles, as erp_app (runtime grants only).
describe("default role provisioning (PostgreSQL, as erp_app)", () => {
  const MOD = `prov_${randomBytes(3).toString("hex")}`;
  // A SAMPLE matrix to exercise the mechanism. The real one is DECISION REQUIRED and stays empty.
  const sample: RolePermissionMatrix = { OWNER: [`${MOD}.read`, `${MOD}.manage`], MANAGER: [`${MOD}.read`], ATTENDANT: [], KITCHEN: [] };
  const tenants = new TenantContextService();
  let app: PrismaClient;
  let owner: PrismaClient;
  let provisioning: TenantProvisioningService;

  beforeAll(async () => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    provisioning = new TenantProvisioningService(app, new TenantScope(tenants));
    for (const action of ["read", "manage"]) await owner.permission.create({ data: { code: `${MOD}.${action}`, module: MOD, description: "Teste" } });
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  const provision = (org: Org, matrix?: RolePermissionMatrix) => tenants.run({ tenantId: org.tenantId }, () => provisioning.provisionDefaultRoles(matrix));
  const rolesOf = (org: Org) => owner.role.findMany({ where: { tenantId: org.tenantId }, orderBy: { code: "asc" } });
  const grantsOf = (org: Org) =>
    owner.rolePermission.findMany({ where: { tenantId: org.tenantId }, include: { role: true, permission: true }, orderBy: { id: "asc" } });

  it("creates the four system roles, active, with no permission while the matrix is undecided; reruns change nothing", async () => {
    const org = await seedOrg(owner, "Prov default");
    expect(await provision(org)).toEqual({ created: ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"], existing: [], conflicts: [], grantsAdded: 0 });
    const first = await rolesOf(org);
    expect(first.map((r) => [r.code, r.name, r.isSystem, r.status])).toEqual([
      ["ATTENDANT", "Atendente", true, RoleStatus.ACTIVE],
      ["KITCHEN", "Cozinha", true, RoleStatus.ACTIVE],
      ["MANAGER", "Gerente", true, RoleStatus.ACTIVE],
      ["OWNER", "Proprietário", true, RoleStatus.ACTIVE],
    ]);
    expect(await grantsOf(org)).toEqual([]);
    expect(DEFAULT_ROLE_PERMISSIONS.OWNER).toEqual([]);

    expect(await provision(org)).toEqual({ created: [], existing: ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"], conflicts: [], grantsAdded: 0 });
    expect((await rolesOf(org)).map((r) => r.id)).toEqual(first.map((r) => r.id)); // stable ids
  });

  it("applies a matrix by adding only missing grants, never removing or duplicating", async () => {
    const org = await seedOrg(owner, "Prov matrix");
    expect((await provision(org, sample)).grantsAdded).toBe(3);
    expect((await grantsOf(org)).map((g) => `${g.role.code}:${g.permission.code}`).sort()).toEqual(
      [`MANAGER:${MOD}.read`, `OWNER:${MOD}.manage`, `OWNER:${MOD}.read`].sort(),
    );
    expect((await provision(org, sample)).grantsAdded).toBe(0);
    // A smaller matrix does not revoke anything already granted.
    expect((await provision(org)).grantsAdded).toBe(0);
    expect(await grantsOf(org)).toHaveLength(3);
  });

  it("is safe under concurrent provisioning of the same tenant", async () => {
    const org = await seedOrg(owner, "Prov concurrent");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => provision(org, sample)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await rolesOf(org)).toHaveLength(4);
    expect(await grantsOf(org)).toHaveLength(3);
    const created = results.flatMap((r) => (r.status === "fulfilled" ? r.value.created : []));
    expect(created.sort()).toEqual(["ATTENDANT", "KITCHEN", "MANAGER", "OWNER"]); // each role created exactly once
  });

  it("never hijacks a customer role using a default code, and never alters existing system roles", async () => {
    const org = await seedOrg(owner, "Prov conflict");
    const custom = await owner.role.create({ data: { tenantId: org.tenantId, code: "MANAGER", name: "Gerente da casa", status: RoleStatus.ACTIVE } });
    const result = await provision(org, sample);
    expect(result.conflicts).toEqual(["MANAGER"]);
    expect(result.created).toEqual(["OWNER", "ATTENDANT", "KITCHEN"]);
    expect(await owner.role.findUniqueOrThrow({ where: { id: custom.id } })).toMatchObject({ isSystem: false, name: "Gerente da casa" });
    expect((await grantsOf(org)).filter((g) => g.roleId === custom.id)).toEqual([]);

    const ownerRole = (await rolesOf(org)).find((r) => r.code === "OWNER")!;
    await owner.role.update({ where: { id: ownerRole.id }, data: { status: RoleStatus.INACTIVE, name: "Dono" } });
    await provision(org, sample);
    expect(await owner.role.findUniqueOrThrow({ where: { id: ownerRole.id } })).toMatchObject({ status: RoleStatus.INACTIVE, name: "Dono" });
  });

  it("rejects a matrix with unknown permissions and writes nothing", async () => {
    const org = await seedOrg(owner, "Prov unknown");
    await expect(provision(org, { ...sample, KITCHEN: ["kitchen.does_not_exist"] })).rejects.toBeInstanceOf(UnknownPermissionInMatrixError);
    expect(await rolesOf(org)).toEqual([]);
  });

  it("touches only the tenant of the context and requires one", async () => {
    const a = await seedOrg(owner, "Prov A");
    const b = await seedOrg(owner, "Prov B");
    await provision(a, sample);
    expect(await rolesOf(b)).toEqual([]);
    expect(await grantsOf(b)).toEqual([]);
    await expect(provisioning.provisionDefaultRoles()).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});
