import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { assignmentKey, parseCreateUser, parseReplaceRoles, parseResetPassword, parseUpdateUser } from "./user-requests.js";

const R1 = "0199a000-0000-7000-8000-0000000000a1";
const R2 = "0199a000-0000-7000-8000-0000000000a2";
const B1 = "0199a000-0000-7000-8000-0000000000b1";

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

describe("parseCreateUser", () => {
  it("trims the name and normalizes the employee number like the login; keeps the password as typed", () => {
    expect(parseCreateUser({ name: "  Ana  ", employeeNumber: " caixa1 ", temporaryPassword: " Senha 12 " })).toEqual({
      name: "Ana",
      employeeNumber: "CAIXA1",
      temporaryPassword: " Senha 12 ",
    });
  });

  it("requires every field and rejects unknown ones (tenantId, status, roles)", () => {
    expect(issuesOf(() => parseCreateUser({}))).toEqual([
      { field: "name", issue: "required" },
      { field: "employeeNumber", issue: "required" },
      { field: "temporaryPassword", issue: "required" },
    ]);
    expect(issuesOf(() => parseCreateUser({ name: "A", employeeNumber: "E1", temporaryPassword: "Senha-123", tenantId: "t", status: "ACTIVE", roles: [] }))).toEqual([
      { field: "tenantId", issue: "unknown_field" },
      { field: "status", issue: "unknown_field" },
      { field: "roles", issue: "unknown_field" },
    ]);
  });

  it("applies the name limits (1–200 after trim)", () => {
    const base = { employeeNumber: "E1", temporaryPassword: "Senha-123" };
    expect(issuesOf(() => parseCreateUser({ ...base, name: "   " }))).toEqual([{ field: "name", issue: "too_short" }]);
    expect(issuesOf(() => parseCreateUser({ ...base, name: "x".repeat(201) }))).toEqual([{ field: "name", issue: "too_long" }]);
    expect(parseCreateUser({ ...base, name: "x".repeat(200) }).name).toHaveLength(200);
  });

  it("rejects an invalid employee number with invalid_format", () => {
    const base = { name: "A", temporaryPassword: "Senha-123" };
    for (const employeeNumber of ["", "   ", "com espaço", "ç1", "x".repeat(33), "a/b"]) {
      expect(issuesOf(() => parseCreateUser({ ...base, employeeNumber })), employeeNumber).toEqual([{ field: "employeeNumber", issue: "invalid_format" }]);
    }
    expect(issuesOf(() => parseCreateUser({ ...base, employeeNumber: 7 }))).toEqual([{ field: "employeeNumber", issue: "invalid_type" }]);
  });

  it("applies the Auth password policy: shorter than 8 = too_short, over the byte limit = too_long", () => {
    const base = { name: "A", employeeNumber: "E1" };
    expect(issuesOf(() => parseCreateUser({ ...base, temporaryPassword: "1234567" }))).toEqual([{ field: "temporaryPassword", issue: "too_short" }]);
    expect(issuesOf(() => parseCreateUser({ ...base, temporaryPassword: "" }))).toEqual([{ field: "temporaryPassword", issue: "too_short" }]);
    expect(issuesOf(() => parseCreateUser({ ...base, temporaryPassword: "x".repeat(1025) }))).toEqual([{ field: "temporaryPassword", issue: "too_long" }]);
    expect(issuesOf(() => parseCreateUser({ ...base, temporaryPassword: 12345678 }))).toEqual([{ field: "temporaryPassword", issue: "invalid_type" }]);
    expect(parseCreateUser({ ...base, temporaryPassword: "12345678" }).temporaryPassword).toBe("12345678");
  });

  it("never echoes the password in the validation details", () => {
    const secret = "short-1";
    const details = issuesOf(() => parseCreateUser({ name: "A", employeeNumber: "E1", temporaryPassword: secret }));
    expect(JSON.stringify(details)).not.toContain(secret);
  });
});

describe("parseUpdateUser", () => {
  it("accepts only the name", () => {
    expect(parseUpdateUser({ name: " Novo " })).toEqual({ name: "Novo" });
    expect(issuesOf(() => parseUpdateUser({ name: "A", employeeNumber: "E2" }))).toEqual([{ field: "employeeNumber", issue: "unknown_field" }]);
    expect(issuesOf(() => parseUpdateUser({ name: "A", status: "DISABLED", mustChangePassword: false }))).toEqual([
      { field: "status", issue: "unknown_field" },
      { field: "mustChangePassword", issue: "unknown_field" },
    ]);
    expect(issuesOf(() => parseUpdateUser({}))).toEqual([{ field: "name", issue: "required" }]);
  });
});

describe("parseResetPassword", () => {
  it("requires a policy-compliant temporary password and nothing else", () => {
    expect(parseResetPassword({ temporaryPassword: "Nova-Senha-1" })).toEqual({ temporaryPassword: "Nova-Senha-1" });
    expect(issuesOf(() => parseResetPassword({ temporaryPassword: "curta" }))).toEqual([{ field: "temporaryPassword", issue: "too_short" }]);
    expect(issuesOf(() => parseResetPassword({ temporaryPassword: "Nova-Senha-1", mustChangePassword: false }))).toEqual([
      { field: "mustChangePassword", issue: "unknown_field" },
    ]);
  });
});

describe("parseReplaceRoles", () => {
  it("accepts tenant-wide and branch-scoped assignments, and an empty list", () => {
    expect(parseReplaceRoles({ roles: [{ roleId: R1, branchId: null }, { roleId: R1, branchId: B1 }, { roleId: R2.toUpperCase(), branchId: null }] })).toEqual([
      { roleId: R1, branchId: null },
      { roleId: R1, branchId: B1 },
      { roleId: R2, branchId: null },
    ]);
    expect(parseReplaceRoles({ roles: [] })).toEqual([]);
  });

  it("rejects a repeated (roleId, branchId) pair on the repeated item", () => {
    expect(issuesOf(() => parseReplaceRoles({ roles: [{ roleId: R1, branchId: null }, { roleId: R2, branchId: null }, { roleId: R1.toUpperCase(), branchId: null }] }))).toEqual([
      { field: "roles[2]", issue: "invalid_value" },
    ]);
    expect(issuesOf(() => parseReplaceRoles({ roles: [{ roleId: R1, branchId: B1 }, { roleId: R1, branchId: B1 }] }))).toEqual([{ field: "roles[1]", issue: "invalid_value" }]);
  });

  it("rejects more than 50 items, malformed items and unknown fields", () => {
    const many = Array.from({ length: 51 }, () => ({ roleId: R1, branchId: null }));
    expect(issuesOf(() => parseReplaceRoles({ roles: many }))).toEqual([{ field: "roles", issue: "too_many" }]);
    expect(issuesOf(() => parseReplaceRoles({ roles: [{ roleId: "x" }, { roleId: R1, branchId: null, tenantId: "t" }] }))).toEqual([
      { field: "roles[0].roleId", issue: "invalid_format" },
      { field: "roles[0].branchId", issue: "required" },
      { field: "roles[1].tenantId", issue: "unknown_field" },
    ]);
    expect(issuesOf(() => parseReplaceRoles({}))).toEqual([{ field: "roles", issue: "required" }]);
    expect(issuesOf(() => parseReplaceRoles({ roles: {} }))).toEqual([{ field: "roles", issue: "invalid_type" }]);
  });

  it("keys an assignment by role and scope", () => {
    expect(assignmentKey({ roleId: R1, branchId: null })).toBe(R1);
    expect(assignmentKey({ roleId: R1, branchId: B1 })).toBe(`${R1}:${B1}`);
  });
});
