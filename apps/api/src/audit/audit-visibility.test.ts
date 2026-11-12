import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_PERMISSIONS } from "../tenants/default-roles.js";
import { auditVisibility, seesNothing } from "./audit-visibility.js";

const X = "0199a000-0000-7000-8000-0000000000b1";
const Y = "0199a000-0000-7000-8000-0000000000b2";
const Z = "0199a000-0000-7000-8000-0000000000b3";
const tenantWide = (permissions: readonly string[]) => ({ branchId: null, permissions });

describe("audit visibility (KAN-41)", () => {
  it("OWNER (tenant-wide): every branch with access plus tenant events", () => {
    expect(auditVisibility([tenantWide(DEFAULT_ROLE_PERMISSIONS.OWNER)], new Set([Y, X]))).toEqual({ branchIds: [X, Y], tenantEvents: true });
  });

  it("OWNER without access to a branch does not see that branch (access says WHERE)", () => {
    expect(auditVisibility([tenantWide(DEFAULT_ROLE_PERMISSIONS.OWNER)], new Set([X]))).toEqual({ branchIds: [X], tenantEvents: true });
  });

  it("MANAGER: only the branches with access, never tenant events", () => {
    expect(auditVisibility([tenantWide(DEFAULT_ROLE_PERMISSIONS.MANAGER)], new Set([X, Y]))).toEqual({ branchIds: [X, Y], tenantEvents: false });
  });

  it("MANAGER scoped to one branch sees only that branch", () => {
    const roles = [{ branchId: X, permissions: DEFAULT_ROLE_PERMISSIONS.MANAGER }, tenantWide(DEFAULT_ROLE_PERMISSIONS.ATTENDANT)];
    expect(auditVisibility(roles, new Set([X, Y]))).toEqual({ branchIds: [X], tenantEvents: false });
  });

  it("ATTENDANT and KITCHEN see nothing (403)", () => {
    for (const role of [DEFAULT_ROLE_PERMISSIONS.ATTENDANT, DEFAULT_ROLE_PERMISSIONS.KITCHEN]) {
      expect(seesNothing(auditVisibility([tenantWide(role)], new Set([X, Y, Z])))).toBe(true);
    }
  });

  it("tenant events need BOTH audit.read and audit.read_tenant in the tenant scope", () => {
    expect(auditVisibility([tenantWide(["audit.read_tenant"])], new Set())).toEqual({ branchIds: [], tenantEvents: false });
    // A branch-scoped role never becomes a tenant permission.
    expect(auditVisibility([{ branchId: X, permissions: ["audit.read", "audit.read_tenant"] }], new Set([X]))).toEqual({ branchIds: [X], tenantEvents: false });
  });

  it("no role at all (inactive user = no assignments) sees nothing", () => {
    expect(seesNothing(auditVisibility([], new Set([X])))).toBe(true);
  });
});
