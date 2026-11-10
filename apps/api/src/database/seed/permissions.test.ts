import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "./permissions.js";

const CODE_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/; // mirrors permissions_code_check

describe("PERMISSION_CATALOG", () => {
  it("has unique codes", () => {
    const codes = PERMISSION_CATALOG.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("satisfies the database CHECKs", () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.code, p.code).toMatch(CODE_FORMAT);
      expect(p.module.trim(), p.code).not.toBe("");
      expect(p.description.trim(), p.code).not.toBe("");
    }
  });
});
