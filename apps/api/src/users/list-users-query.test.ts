import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { likeContainsPattern, parseListUsersQuery } from "./list-users-query.js";

function issuesOf(query: unknown): unknown {
  try {
    parseListUsersQuery(query);
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

describe("parseListUsersQuery", () => {
  it("defaults to page 1 of 20 with no filter", () => {
    expect(parseListUsersQuery({})).toEqual({ filter: {}, page: { page: 1, pageSize: 20, skip: 0, take: 20 } });
    expect(parseListUsersQuery(undefined)).toEqual({ filter: {}, page: { page: 1, pageSize: 20, skip: 0, take: 20 } });
  });

  it("accepts every status, a trimmed search and paging", () => {
    for (const status of ["ACTIVE", "DISABLED", "LOCKED"]) {
      expect(parseListUsersQuery({ status }).filter).toEqual({ status });
    }
    expect(parseListUsersQuery({ search: "  ana  ", page: "3", pageSize: "100" })).toEqual({
      filter: { search: "ana" },
      page: { page: 3, pageSize: 100, skip: 200, take: 100 },
    });
    expect(parseListUsersQuery({ search: "x".repeat(100) }).filter.search).toHaveLength(100);
  });

  it("rejects an unknown status", () => {
    expect(issuesOf({ status: "active" })).toEqual([{ field: "status", issue: "invalid_value" }]);
    expect(issuesOf({ status: "ARCHIVED" })).toEqual([{ field: "status", issue: "invalid_value" }]);
  });

  it("rejects an empty (after trim) or too long search", () => {
    expect(issuesOf({ search: "" })).toEqual([{ field: "search", issue: "too_short" }]);
    expect(issuesOf({ search: "   " })).toEqual([{ field: "search", issue: "too_short" }]);
    expect(issuesOf({ search: "x".repeat(101) })).toEqual([{ field: "search", issue: "too_long" }]);
    expect(issuesOf({ search: ["a", "b"] })).toEqual([{ field: "search", issue: "invalid_type" }]);
  });

  it("rejects unknown fields, including tenantId", () => {
    expect(issuesOf({ tenantId: "t", sort: "name" })).toEqual([
      { field: "tenantId", issue: "unknown_field" },
      { field: "sort", issue: "unknown_field" },
    ]);
  });

  it("applies the shared paging limits (pageSize at most 100)", () => {
    expect(issuesOf({ pageSize: "101" })).toEqual([{ field: "pageSize", issue: "invalid_value" }]);
    expect(issuesOf({ page: "0" })).toEqual([{ field: "page", issue: "invalid_value" }]);
    expect(issuesOf({ page: "x" })).toEqual([{ field: "page", issue: "invalid_format" }]);
  });

  it("collects every issue in one error", () => {
    expect(issuesOf({ status: "X", search: " ", pageSize: "500", tenantId: "t" })).toEqual([
      { field: "tenantId", issue: "unknown_field" },
      { field: "pageSize", issue: "invalid_value" },
      { field: "status", issue: "invalid_value" },
      { field: "search", issue: "too_short" },
    ]);
  });
});

describe("likeContainsPattern", () => {
  it("wraps the term in % and escapes the LIKE wildcards and the escape character", () => {
    expect(likeContainsPattern("ana")).toBe("%ana%");
    expect(likeContainsPattern("100%")).toBe("%100\\%%");
    expect(likeContainsPattern("a_b")).toBe("%a\\_b%");
    expect(likeContainsPattern("a\\b")).toBe("%a\\\\b%");
    expect(likeContainsPattern("%_\\")).toBe("%\\%\\_\\\\%");
  });
});
