import { describe, expect, it } from "vitest";
import { normalizeLoginCode } from "../tenants/login-code.js";
import { normalizeEmployeeNumber } from "./employee-number.js";

describe("normalizeEmployeeNumber", () => {
  it("trims, uppercases and preserves leading zeros", () => {
    expect(normalizeEmployeeNumber("  mor-0042a ")).toBe("MOR-0042A");
    expect(normalizeEmployeeNumber("007")).toBe("007");
    expect(normalizeEmployeeNumber("a.b_c-1")).toBe("A.B_C-1");
    expect(normalizeEmployeeNumber("X".repeat(32))).toBe("X".repeat(32));
  });

  it("rejects empty, too long, inner spaces and characters outside [A-Z0-9._-]", () => {
    for (const raw of ["", "   ", "X".repeat(33), "12 34", "ab/1", "ação", "1;DROP", "a\u0000", "\t", undefined, 7, null]) {
      expect(normalizeEmployeeNumber(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("does not let Unicode case mapping turn invalid input into a valid number", () => {
    for (const raw of ["ıd", "ﬀ01", "ß1", "K1"]) expect(normalizeEmployeeNumber(raw), raw).toBeNull();
  });
});

describe("normalizeLoginCode", () => {
  it("trims and uppercases valid codes", () => {
    expect(normalizeLoginCode(" loja-centro ")).toBe("LOJA-CENTRO");
    expect(normalizeLoginCode("0042")).toBe("0042");
  });

  it("rejects short, long, edge hyphens, spaces and other characters", () => {
    for (const raw of ["abc", "X".repeat(33), "-ABCD", "ABCD-", "AB CD", "AB_CD", "ÁBCD", "ıabc", "", undefined]) {
      expect(normalizeLoginCode(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
