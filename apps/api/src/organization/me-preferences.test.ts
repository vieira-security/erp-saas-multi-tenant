import { CATALOG_VIEWS as CONTRACT_CATALOG_VIEWS } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { CATALOG_VIEWS, DEFAULT_PREFERENCES, parseUpdatePreferences } from "./me-preferences.service.js";

function issues(body: unknown): unknown {
  try {
    parseUpdatePreferences(body);
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  return [];
}

describe("PUT /me/preferences body (KAN-42)", () => {
  it("mirrors CATALOG_VIEWS of the contract and defaults to GRID", () => {
    expect([...CATALOG_VIEWS]).toEqual([...CONTRACT_CATALOG_VIEWS]);
    expect(DEFAULT_PREFERENCES).toEqual({ catalogView: "GRID" });
  });

  it("accepts each catalog view", () => {
    for (const catalogView of CATALOG_VIEWS) expect(parseUpdatePreferences({ catalogView })).toEqual({ catalogView });
  });

  it("rejects empty body (required), values outside the list, wrong types and unknown fields (userId/tenantId)", () => {
    expect(issues({})).toEqual([{ field: "catalogView", issue: "required" }]);
    expect(issues({ catalogView: "grid" })).toEqual([{ field: "catalogView", issue: "invalid_value" }]);
    expect(issues({ catalogView: 1 })).toEqual([{ field: "catalogView", issue: "invalid_type" }]);
    expect(issues({ catalogView: "LIST", userId: "x", tenantId: "y" })).toEqual([
      { field: "userId", issue: "unknown_field" },
      { field: "tenantId", issue: "unknown_field" },
    ]);
    expect(issues(null)).toEqual([{ field: "body", issue: "invalid_type" }]);
  });
});
