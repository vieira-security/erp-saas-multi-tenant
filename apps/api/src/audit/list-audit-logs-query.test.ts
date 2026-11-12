import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { parseListAuditLogsQuery } from "./list-audit-logs-query.js";

const U = "0199A000-0000-7000-8000-0000000000A1";

function issues(query: unknown): unknown {
  try {
    parseListAuditLogsQuery(query);
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  return [];
}

describe("GET /audit-logs query (strict parser)", () => {
  it("defaults to the first page of 20 with no filter", () => {
    expect(parseListAuditLogsQuery({})).toEqual({ filter: {}, page: { page: 1, pageSize: 20, skip: 0, take: 20 } });
    expect(parseListAuditLogsQuery(undefined).filter).toEqual({});
  });

  it("parses every filter (ids lowercased, actions deduplicated, instants with time zone)", () => {
    const { filter, page } = parseListAuditLogsQuery({
      from: "2026-11-10T00:00:00-03:00",
      to: "2026-11-11T00:00:00.000Z",
      action: "product.updated,product.created,product.updated",
      userId: U,
      branchId: U,
      resourceType: "product",
      resourceId: U,
      page: "2",
      pageSize: "100",
    });
    expect(filter).toEqual({
      from: new Date("2026-11-10T03:00:00.000Z"),
      to: new Date("2026-11-11T00:00:00.000Z"),
      actions: ["product.updated", "product.created"],
      userId: U.toLowerCase(),
      branchId: U.toLowerCase(),
      resourceType: "product",
      resourceId: U.toLowerCase(),
    });
    expect(page).toEqual({ page: 2, pageSize: 100, skip: 100, take: 100 });
  });

  it("accepts from == to (empty window) and rejects from > to on `from`", () => {
    expect(issues({ from: "2026-11-10T00:00:00Z", to: "2026-11-10T00:00:00Z" })).toEqual([]);
    expect(issues({ from: "2026-11-10T00:00:01Z", to: "2026-11-10T00:00:00Z" })).toEqual([{ field: "from", issue: "invalid_value" }]);
  });

  it("rejects instants without time zone, malformed or impossible dates", () => {
    expect(issues({ from: "2026-11-10" })).toEqual([{ field: "from", issue: "invalid_format" }]);
    expect(issues({ from: "2026-11-10T10:00:00" })).toEqual([{ field: "from", issue: "invalid_format" }]);
    expect(issues({ to: "ontem" })).toEqual([{ field: "to", issue: "invalid_format" }]);
    expect(issues({ from: "2026-02-30T00:00:00Z" })).toEqual([{ field: "from", issue: "invalid_value" }]);
    expect(issues({ to: "2026-11-10T24:00:00Z" })).toEqual([{ field: "to", issue: "invalid_value" }]);
    expect(issues({ from: ["2026-11-10T00:00:00Z"] })).toEqual([{ field: "from", issue: "invalid_type" }]);
  });

  it("validates actions against the catalog (CSV, no blanks, no spaces)", () => {
    for (const action of ["product.deleted", "product.updated,", ",product.updated", "product.updated, product.created", "", "auth.*"]) {
      expect(issues({ action }), action).toEqual([{ field: "action", issue: "invalid_value" }]);
    }
    expect(issues({ action: "auth.login.failed,kitchen_ticket.reprinted" })).toEqual([]);
  });

  it("rejects non-UUID ids, bad resource types, page size above 100 and unknown fields (tenantId included)", () => {
    expect(issues({ userId: "1", branchId: "x", resourceId: "abc" })).toEqual([
      { field: "userId", issue: "invalid_format" },
      { field: "branchId", issue: "invalid_format" },
      { field: "resourceId", issue: "invalid_format" },
    ]);
    expect(issues({ resourceType: "Product" })).toEqual([{ field: "resourceType", issue: "invalid_format" }]);
    expect(issues({ resourceType: "product;drop" })).toEqual([{ field: "resourceType", issue: "invalid_format" }]);
    expect(issues({ pageSize: "101" })).toEqual([{ field: "pageSize", issue: "invalid_value" }]);
    expect(issues({ tenantId: U, sort: "asc" })).toEqual([
      { field: "tenantId", issue: "unknown_field" },
      { field: "sort", issue: "unknown_field" },
    ]);
  });
});
