import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "../database/seed/permissions.js";
import { DEFAULT_ROLES, DEFAULT_ROLE_PERMISSIONS } from "./default-roles.js";

describe("default roles and permission matrix", () => {
  it("declares exactly the four documented default roles", () => {
    expect(DEFAULT_ROLES.map((r) => r.code)).toEqual(["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"]);
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual(["ATTENDANT", "KITCHEN", "MANAGER", "OWNER"]);
  });

  it("only references permissions of the global catalog, without duplicates", () => {
    const catalog = new Set(PERMISSION_CATALOG.map((p) => p.code));
    for (const [role, codes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      expect(new Set(codes).size, role).toBe(codes.length);
      for (const code of codes) expect(catalog.has(code), `${role}: ${code}`).toBe(true);
    }
  });

  it("is exactly the approved matrix", () => {
    const sorted = (codes: readonly string[]) => [...codes].sort();
    expect(sorted(DEFAULT_ROLE_PERMISSIONS.OWNER)).toEqual(sorted(PERMISSION_CATALOG.map((p) => p.code).slice(0, 19)));
    expect(DEFAULT_ROLE_PERMISSIONS.OWNER).toHaveLength(19);
    expect(sorted(DEFAULT_ROLE_PERMISSIONS.MANAGER)).toEqual(
      sorted([
        "organization.read", "branch.read", "user.read", "user.manage", "role.read", "product.read", "product.manage",
        "order.read", "order.create", "order.cancel", "cash.read", "cash.open", "cash.close", "fiscal.read", "fiscal.issue",
        "fiscal.cancel",
      ]),
    );
    expect(sorted(DEFAULT_ROLE_PERMISSIONS.ATTENDANT)).toEqual(
      sorted(["branch.read", "product.read", "order.read", "order.create", "cash.read", "cash.open", "fiscal.read", "fiscal.issue"]),
    );
    expect(sorted(DEFAULT_ROLE_PERMISSIONS.KITCHEN)).toEqual(["order.read", "product.read"]);
  });

  it("forces an explicit decision for every catalog permission (OWNER gets nothing automatically)", () => {
    // OWNER is an explicit list, not "the whole catalog": a new catalog permission fails here until it is added,
    // role by role, to the matrix.
    const assigned = new Set(Object.values(DEFAULT_ROLE_PERMISSIONS).flat());
    for (const { code } of PERMISSION_CATALOG) expect(assigned.has(code), code).toBe(true);
    expect(PERMISSION_CATALOG).toHaveLength(19);
  });

  it("never grants a role more than OWNER holds (no role above OWNER)", () => {
    const owner = new Set(DEFAULT_ROLE_PERMISSIONS.OWNER);
    for (const [role, codes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const code of codes) expect(owner.has(code), `${role}: ${code}`).toBe(true);
    }
  });
});
