import { describe, expect, it } from "vitest";
import { TenantContextMissingError, TenantContextService } from "./tenant-context.js";
import { MODEL_SCOPE, TenantScope, TenantScopeViolationError } from "./tenant-scope.js";

const A = "0199a000-0000-7000-8000-00000000000a";
const B = "0199b000-0000-7000-8000-00000000000b";

describe("TenantScope", () => {
  const tenants = new TenantContextService();
  const scope = new TenantScope(tenants);

  it("adds the context tenant to where and data", () => {
    tenants.run({ tenantId: A }, () => {
      expect(scope.where({ id: "x" })).toEqual({ id: "x", tenantId: A });
      expect(scope.where({})).toEqual({ tenantId: A });
      expect(scope.where({ OR: [{ id: "x" }, { id: "y" }] })).toEqual({ OR: [{ id: "x" }, { id: "y" }], tenantId: A });
      expect(scope.data({ name: "n" })).toEqual({ name: "n", tenantId: A });
      expect(scope.tenantId()).toBe(A);
    });
  });

  it("follows the current context, not the one at construction time", () => {
    expect(tenants.run({ tenantId: B }, () => scope.where({ id: "x" }))).toEqual({ id: "x", tenantId: B });
  });

  it("fails without a context instead of producing an unscoped query", () => {
    expect(() => scope.where({ id: "x" })).toThrow(TenantContextMissingError);
    expect(() => scope.data({ name: "n" })).toThrow(TenantContextMissingError);
    expect(() => scope.tenantId()).toThrow(TenantContextMissingError);
  });

  it("rejects a caller-provided tenantId or tenant relation, even when it equals the context tenant", () => {
    tenants.run({ tenantId: A }, () => {
      // The types already forbid these; the casts stand for untyped input reaching the helper.
      expect(() => scope.where({ id: "x", tenantId: B } as never)).toThrow(TenantScopeViolationError);
      expect(() => scope.where({ tenantId: A } as never)).toThrow(TenantScopeViolationError);
      expect(() => scope.data({ name: "n", tenantId: B } as never)).toThrow(TenantScopeViolationError);
      expect(() => scope.data({ name: "n", tenant: { connect: { id: B } } } as never)).toThrow(TenantScopeViolationError);
      expect(() => scope.where({ tenantId: undefined } as never)).toThrow(TenantScopeViolationError);
    });
  });

  it("classifies Tenant as root, Permission as global and every other model as tenant-scoped", () => {
    const byScope = (s: string) => Object.entries(MODEL_SCOPE).filter(([, v]) => v === s).map(([k]) => k).sort();
    expect(byScope("root")).toEqual(["Tenant"]);
    expect(byScope("global")).toEqual(["Permission"]);
    expect(byScope("tenant")).toEqual(
      ["AuditLog", "Branch", "Company", "Device", "Role", "RolePermission", "Session", "User", "UserBranchAccess", "UserRole"],
    );
  });
});
