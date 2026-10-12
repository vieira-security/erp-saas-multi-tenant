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

  it("grants nothing until the matrix is approved (DECISION REQUIRED)", () => {
    // Remove this test together with filling the matrix, after the product decision.
    expect(Object.values(DEFAULT_ROLE_PERMISSIONS).every((codes) => codes.length === 0)).toBe(true);
  });
});
