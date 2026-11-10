import { PERMISSION_CODES } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "../database/seed/permissions.js";
import { TENANT_SCOPE, branchScope } from "./authorization.service.js";
import { resolveEffectivePermissions, sortedPermissionCodes, type RoleAssignment } from "./effective-permissions.js";

const A = "0199a000-0000-7000-8000-00000000000a";
const B = "0199b000-0000-7000-8000-00000000000b";

describe("resolveEffectivePermissions (same rule as AuthorizationService)", () => {
  const assignments: RoleAssignment[] = [
    { branchId: null, permissions: ["order.read", "product.read"] },
    { branchId: A, permissions: ["cash.close", "order.read"] },
    { branchId: B, permissions: ["user.manage"] },
  ];

  it("tenant scope counts only tenant-wide roles", () => {
    expect(sortedPermissionCodes(resolveEffectivePermissions(assignments, TENANT_SCOPE, new Set([A, B])))).toEqual(["order.read", "product.read"]);
  });

  it("branch scope adds the roles of that branch only, and only with access", () => {
    const access = new Set([A]);
    expect(sortedPermissionCodes(resolveEffectivePermissions(assignments, branchScope(A), access))).toEqual(["cash.close", "order.read", "product.read"]);
    // B has a scoped role but no access: nothing, not even the tenant-wide roles.
    expect([...resolveEffectivePermissions(assignments, branchScope(B), access)]).toEqual([]);
  });

  it("no assignments = no permissions anywhere", () => {
    expect([...resolveEffectivePermissions([], TENANT_SCOPE, new Set([A]))]).toEqual([]);
    expect([...resolveEffectivePermissions([], branchScope(A), new Set([A]))]).toEqual([]);
  });

  it("sorts by code point, not by locale/collation", () => {
    expect(sortedPermissionCodes(["role.read", "Zeta.x", "order_x.read", "order.read"])).toEqual(["Zeta.x", "order.read", "order_x.read", "role.read"]);
  });
});

describe("PERMISSION_CODES (contract) mirrors the seeded permission catalog", () => {
  it("has exactly the catalog codes, in the same order", () => {
    // A new permission in the catalog needs a product decision and an update of packages/contracts/src/me.ts.
    expect([...PERMISSION_CODES]).toEqual(PERMISSION_CATALOG.map((p) => p.code));
  });
});
