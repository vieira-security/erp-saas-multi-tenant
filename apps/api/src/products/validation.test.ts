import * as contract from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { parseInput, required } from "../http/input.js";
import * as api from "./validation.js";
import { description, optionGroups, productCode } from "./validation.js";

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

const parseGroups = (value: unknown) => parseInput({ optionGroups: value }, { optionGroups: required(optionGroups) }).optionGroups;
const option = (name = "Opção", extra: Record<string, unknown> = {}) => ({ name, ...extra });
const group = (extra: Record<string, unknown> = {}) => ({ name: "Tamanho", minChoices: 1, maxChoices: 1, options: [option("P"), option("G")], ...extra });

describe("M4 constants", () => {
  it("match the values published in @erp/contracts", () => {
    expect({
      PRODUCT_NAME_MAX_LENGTH: api.PRODUCT_NAME_MAX_LENGTH,
      PRODUCT_DESCRIPTION_MAX_LENGTH: api.PRODUCT_DESCRIPTION_MAX_LENGTH,
      PRODUCT_CATEGORY_NAME_MAX_LENGTH: api.PRODUCT_CATEGORY_NAME_MAX_LENGTH,
      OPTION_NAME_MAX_LENGTH: api.OPTION_NAME_MAX_LENGTH,
      OPTION_GROUPS_MAX: api.OPTION_GROUPS_MAX,
      OPTIONS_PER_GROUP_MAX: api.OPTIONS_PER_GROUP_MAX,
      SORT_ORDER_MAX: api.SORT_ORDER_MAX,
    }).toEqual({
      PRODUCT_NAME_MAX_LENGTH: contract.PRODUCT_NAME_MAX_LENGTH,
      PRODUCT_DESCRIPTION_MAX_LENGTH: contract.PRODUCT_DESCRIPTION_MAX_LENGTH,
      PRODUCT_CATEGORY_NAME_MAX_LENGTH: contract.PRODUCT_CATEGORY_NAME_MAX_LENGTH,
      OPTION_NAME_MAX_LENGTH: contract.OPTION_NAME_MAX_LENGTH,
      OPTION_GROUPS_MAX: contract.OPTION_GROUPS_MAX,
      OPTIONS_PER_GROUP_MAX: contract.OPTIONS_PER_GROUP_MAX,
      SORT_ORDER_MAX: contract.SORT_ORDER_MAX,
    });
    expect(api.STATUSES).toEqual(contract.PRODUCT_STATUSES);
    expect(api.STATUSES).toEqual(contract.PRODUCT_CATEGORY_STATUSES);
  });

  it("only uses error and issue codes published in the contract", () => {
    for (const code of ["product_code_already_exists", "linked_product_invalid", "not_found", "validation_failed"]) {
      expect(contract.API_ERROR_CODES).toContain(code);
    }
    for (const issue of ["invalid_money", "min_greater_than_max", "max_greater_than_options", "too_many", "too_few", "unknown_field"]) {
      expect(contract.VALIDATION_ISSUE_CODES).toContain(issue);
    }
  });
});

describe("product fields", () => {
  it("normalizes the product code like Branch.code", () => {
    expect(productCode(" xb-01 ")).toEqual({ ok: true, value: "XB-01" });
    expect(productCode("X B")).toEqual({ ok: false, issue: "invalid_format" });
    expect(productCode("")).toEqual({ ok: false, issue: "too_short" });
    expect(productCode(12)).toEqual({ ok: false, issue: "invalid_type" });
  });

  it("trims the description and turns empty into null", () => {
    expect(description("  Pão, carne  ")).toEqual({ ok: true, value: "Pão, carne" });
    expect(description("   ")).toEqual({ ok: true, value: null });
    expect(description(null)).toEqual({ ok: true, value: null });
    expect(description("x".repeat(500))).toEqual({ ok: true, value: "x".repeat(500) });
    expect(description("x".repeat(501))).toEqual({ ok: false, issue: "too_long" });
    expect(description(1)).toEqual({ ok: false, issue: "invalid_type" });
  });
});

describe("option groups", () => {
  it("accepts a valid list with defaults and keeps the list order", () => {
    const linked = "0198A1B2-0000-7000-8000-000000000000";
    expect(
      parseGroups([
        group({ name: " Tamanho ", options: [option("P"), option("G", { priceDelta: "7.5" })] }),
        { name: "Bebida", minChoices: 0, maxChoices: 1, options: [option("Refri", { linkedProductId: linked })] },
      ]),
    ).toEqual([
      {
        name: "Tamanho",
        minChoices: 1,
        maxChoices: 1,
        options: [
          { name: "P", priceDelta: "0.00", linkedProductId: null },
          { name: "G", priceDelta: "7.50", linkedProductId: null },
        ],
      },
      { name: "Bebida", minChoices: 0, maxChoices: 1, options: [{ name: "Refri", priceDelta: "0.00", linkedProductId: linked.toLowerCase() }] },
    ]);
    expect(parseGroups([])).toEqual([]);
  });

  it("enforces min ≤ max ≤ number of options", () => {
    expect(issuesOf(() => parseGroups([group({ minChoices: 2, maxChoices: 1 })]))).toEqual([
      { field: "optionGroups[0].minChoices", issue: "min_greater_than_max" },
    ]);
    expect(issuesOf(() => parseGroups([group({ minChoices: 0, maxChoices: 3 })]))).toEqual([
      { field: "optionGroups[0].maxChoices", issue: "max_greater_than_options" },
    ]);
    expect(issuesOf(() => parseGroups([group({ minChoices: 4, maxChoices: 3 })]))).toEqual([
      { field: "optionGroups[0].minChoices", issue: "min_greater_than_max" },
      { field: "optionGroups[0].maxChoices", issue: "max_greater_than_options" },
    ]);
  });

  it("limits groups (≤ 20) and options per group (1–50)", () => {
    expect(parseGroups(Array.from({ length: 20 }, () => group()))).toHaveLength(20);
    expect(issuesOf(() => parseGroups(Array.from({ length: 21 }, () => group())))).toEqual([{ field: "optionGroups", issue: "too_many" }]);
    expect(issuesOf(() => parseGroups([group({ minChoices: 0, maxChoices: 1, options: [] })]))).toEqual([
      { field: "optionGroups[0].options", issue: "too_few" },
    ]);
    const fifty = Array.from({ length: 50 }, (_, i) => option(`O${i}`));
    expect(parseGroups([group({ maxChoices: 50, options: fifty })])[0]?.options).toHaveLength(50);
    expect(issuesOf(() => parseGroups([group({ options: [...fifty, option("51")] })]))).toEqual([
      { field: "optionGroups[0].options", issue: "too_many" },
    ]);
  });

  it("validates every nested field, rejects unknown ones and reports all issues with their path", () => {
    expect(
      issuesOf(() =>
        parseGroups([
          group(),
          {
            name: "",
            minChoices: 1.5,
            maxChoices: 51,
            tenantId: "x",
            options: [option(" "), { name: "Bacon", priceDelta: 4, linkedProductId: "nope", id: "x" }, "texto"],
          },
        ]),
      ),
    ).toEqual([
      { field: "optionGroups[1].tenantId", issue: "unknown_field" },
      { field: "optionGroups[1].name", issue: "too_short" },
      { field: "optionGroups[1].minChoices", issue: "invalid_type" },
      { field: "optionGroups[1].maxChoices", issue: "invalid_value" },
      { field: "optionGroups[1].options[0].name", issue: "too_short" },
      { field: "optionGroups[1].options[1].id", issue: "unknown_field" },
      { field: "optionGroups[1].options[1].priceDelta", issue: "invalid_money" },
      { field: "optionGroups[1].options[1].linkedProductId", issue: "invalid_format" },
      { field: "optionGroups[1].options[2]", issue: "invalid_type" },
    ]);
    expect(issuesOf(() => parseGroups({}))).toEqual([{ field: "optionGroups", issue: "invalid_type" }]);
    expect(issuesOf(() => parseGroups([null]))).toEqual([{ field: "optionGroups[0]", issue: "invalid_type" }]);
    expect(issuesOf(() => parseGroups([group({ minChoices: -1 })]))).toEqual([{ field: "optionGroups[0].minChoices", issue: "invalid_value" }]);
    expect(issuesOf(() => parseGroups([group({ options: [option("P", { priceDelta: "-1" })] })]))).toEqual([
      { field: "optionGroups[0].options[0].priceDelta", issue: "invalid_money" },
    ]);
  });
});
