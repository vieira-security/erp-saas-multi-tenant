import { API_ERROR_CODES, PAGE_SIZE_DEFAULT as CONTRACT_DEFAULT, PAGE_SIZE_MAX as CONTRACT_MAX } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "./api-error.js";
import { checked, nullable, oneOf, optional, parseInput, queryInt, required, text, uuid } from "./input.js";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, pageQuerySpec, pageRequest, toPage } from "./paging.js";

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

describe("parseInput", () => {
  const spec = {
    name: required(text(10)),
    nick: optional(text(5)),
    id: optional(uuid),
    cnpj: optional(nullable(checked((v) => (v === "ok" ? { ok: true, value: "OK" } : { ok: false, issue: "invalid_cnpj" })))),
    kind: optional(oneOf(["A", "B"] as const)),
  };

  it("returns only declared and present fields, trimmed and normalized", () => {
    expect(parseInput({ name: "  Ana  ", cnpj: "ok", id: "0198A1B2-0000-7000-8000-000000000000" }, spec)).toEqual({
      name: "Ana",
      cnpj: "OK",
      id: "0198a1b2-0000-7000-8000-000000000000",
    });
    expect(parseInput({ name: "x", cnpj: null }, spec)).toEqual({ name: "x", cnpj: null });
  });

  it("rejects unknown fields, including tenantId (mass assignment)", () => {
    expect(issuesOf(() => parseInput({ name: "x", tenantId: "t", status: "ACTIVE" }, spec))).toEqual([
      { field: "tenantId", issue: "unknown_field" },
      { field: "status", issue: "unknown_field" },
    ]);
  });

  it("collects every issue in one error", () => {
    expect(issuesOf(() => parseInput({ nick: "toolong", id: "nope", kind: "C", cnpj: 1 }, spec))).toEqual([
      { field: "name", issue: "required" },
      { field: "nick", issue: "too_long" },
      { field: "id", issue: "invalid_format" },
      { field: "cnpj", issue: "invalid_type" },
      { field: "kind", issue: "invalid_value" },
    ]);
    expect(issuesOf(() => parseInput({ name: "   " }, spec))).toEqual([{ field: "name", issue: "too_short" }]);
    expect(issuesOf(() => parseInput({ name: 5 }, spec))).toEqual([{ field: "name", issue: "invalid_type" }]);
  });

  it("rejects a body that is not a plain object", () => {
    for (const body of [undefined, null, [], "x", 1, new Date()]) {
      expect(issuesOf(() => parseInput(body, spec))).toEqual([{ field: "body", issue: "invalid_type" }]);
    }
  });

  it("treats a missing query as empty", () => {
    expect(parseInput(undefined, { page: optional(queryInt(5)) }, "query")).toEqual({});
  });

  it("does not let __proto__ in JSON reach the output", () => {
    const body = JSON.parse('{"name":"x","__proto__":{"admin":true}}') as unknown;
    expect(issuesOf(() => parseInput(body, spec))).toEqual([{ field: "__proto__", issue: "unknown_field" }]);
  });
});

describe("paging", () => {
  it("matches the values published in @erp/contracts", () => {
    expect([PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX]).toEqual([CONTRACT_DEFAULT, CONTRACT_MAX]);
  });

  it("parses page and pageSize from the query string", () => {
    expect(parseInput({ page: "3", pageSize: "50" }, pageQuerySpec, "query")).toEqual({ page: 3, pageSize: 50 });
    expect(issuesOf(() => parseInput({ page: "0", pageSize: "101" }, pageQuerySpec, "query"))).toEqual([
      { field: "page", issue: "invalid_value" },
      { field: "pageSize", issue: "invalid_value" },
    ]);
    expect(issuesOf(() => parseInput({ page: "1.5", pageSize: ["1", "2"] }, pageQuerySpec, "query"))).toEqual([
      { field: "page", issue: "invalid_format" },
      { field: "pageSize", issue: "invalid_format" },
    ]);
  });

  it("builds offsets and page metadata", () => {
    const request = pageRequest({ page: 2, pageSize: 10 });
    expect(request).toEqual({ page: 2, pageSize: 10, skip: 10, take: 10 });
    expect(pageRequest({})).toEqual({ page: 1, pageSize: 20, skip: 0, take: 20 });
    expect(toPage([1, 2], 12, request, (n) => n * 10)).toEqual({ items: [10, 20], page: 2, pageSize: 10, total: 12, totalPages: 2 });
    expect(toPage([], 0, request, (n) => n)).toEqual({ items: [], page: 2, pageSize: 10, total: 0, totalPages: 0 });
  });

  it("only uses error codes published in the contract", () => {
    expect(API_ERROR_CODES).toContain("validation_failed");
  });
});
