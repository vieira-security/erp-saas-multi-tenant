import * as contract from "@erp/contracts";
import type { MenuDto, MenuProductDto } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { uuidV7 } from "../database/uuid-v7.js";
import { ValidationFailedError } from "../http/api-error.js";
import { parseInput, required } from "../http/input.js";
import { MONEY_MAX_CENTS, centsToMoney, moneyToCents } from "../http/money.js";
import { businessDate, isCalendarDate } from "./business-date.js";
import { isConfirmed, nextStatus, type OrderAction } from "./order-state.js";
import { priceItems, type OrderItemValue } from "./pricing.js";
import * as api from "./validation.js";

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

describe("M5 constants", () => {
  it("match the values published in @erp/contracts", () => {
    expect(api.ORDER_STATUSES).toEqual(contract.ORDER_STATUSES);
    expect([api.ORDER_ITEMS_MAX, api.ORDER_ITEM_QUANTITY_MAX, api.ORDER_ITEM_NOTE_MAX_LENGTH, api.CANCEL_REASON_MIN_LENGTH, api.CANCEL_REASON_MAX_LENGTH]).toEqual([
      contract.ORDER_ITEMS_MAX,
      contract.ORDER_ITEM_QUANTITY_MAX,
      contract.ORDER_ITEM_NOTE_MAX_LENGTH,
      contract.CANCEL_REASON_MIN_LENGTH,
      contract.CANCEL_REASON_MAX_LENGTH,
    ]);
    expect(api.ORDER_ITEM_OPTION_IDS_MAX).toBe(contract.OPTION_GROUPS_MAX * contract.OPTIONS_PER_GROUP_MAX);
  });

  it("only uses error and issue codes published in the contract", () => {
    for (const code of ["order_not_editable", "order_invalid_transition", "order_empty", "order_item_unavailable", "branch_inactive", "company_inactive"]) {
      expect(contract.API_ERROR_CODES).toContain(code);
    }
    for (const issue of ["unavailable", "invalid_choices", "invalid_value", "required"]) expect(contract.VALIDATION_ISSUE_CODES).toContain(issue);
  });
});

describe("money in cents (bigint, no float)", () => {
  it("converts both ways exactly", () => {
    expect(moneyToCents("0.10")).toBe(10n);
    expect(moneyToCents("12.50")).toBe(1250n);
    expect(moneyToCents("9999999999.99")).toBe(MONEY_MAX_CENTS);
    expect(centsToMoney(0n)).toBe("0.00");
    expect(centsToMoney(5n)).toBe("0.05");
    expect(centsToMoney(30n)).toBe("0.30");
    expect(centsToMoney(MONEY_MAX_CENTS)).toBe("9999999999.99");
    expect(() => moneyToCents("1.5")).toThrow();
    expect(() => centsToMoney(-1n)).toThrow();
  });

  it("sums many small values without drift", () => {
    let floatSum = 0;
    let cents = 0n;
    for (let i = 0; i < 1000; i++) {
      floatSum += 0.1;
      cents += moneyToCents("0.10");
    }
    expect(floatSum).not.toBe(100);
    expect(centsToMoney(cents)).toBe("100.00");
  });
});

describe("uuidV7", () => {
  it("produces version-7 RFC 9562 UUIDs carrying the timestamp", () => {
    const ms = Date.UTC(2026, 10, 9, 12, 0, 0);
    const id = uuidV7(ms);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(ms);
    expect(uuidV7(ms)).not.toBe(id);
  });
});

describe("businessDate (branch time zone)", () => {
  it.each([
    ["2026-11-09T02:59:59.999Z", "America/Sao_Paulo", "2026-11-08"],
    ["2026-11-09T03:00:00.000Z", "America/Sao_Paulo", "2026-11-09"],
    ["2026-11-09T03:59:59.999Z", "America/Manaus", "2026-11-08"],
    ["2026-11-09T04:00:00.000Z", "America/Manaus", "2026-11-09"],
    ["2026-11-09T02:59:59.999Z", "UTC", "2026-11-09"],
    ["2026-12-31T23:30:00.000Z", "America/Noronha", "2026-12-31"],
    ["2027-01-01T02:00:00.000Z", "America/Noronha", "2027-01-01"],
  ])("%s in %s is %s", (instant, zone, day) => {
    expect(businessDate(new Date(instant), zone)).toBe(day);
  });

  it("validates calendar dates", () => {
    expect(isCalendarDate("2026-11-09")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const v of ["2026-02-30", "2026-13-01", "2026-11-9", "09/11/2026", ""]) expect(isCalendarDate(v)).toBe(false);
  });
});

describe("order state machine", () => {
  const all = contract.ORDER_STATUSES;
  const valid: Record<OrderAction, Partial<Record<(typeof all)[number], (typeof all)[number]>>> = {
    confirm: { EDITING: "CONFIRMED" },
    start: { CONFIRMED: "PREPARING" },
    ready: { PREPARING: "READY" },
    deliver: { READY: "DELIVERED" },
    // M6: DELIVERED is cancellable too (full refund).
    cancel: { EDITING: "CANCELLED", CONFIRMED: "CANCELLED", PREPARING: "CANCELLED", READY: "CANCELLED", DELIVERED: "CANCELLED" },
  };

  it("accepts exactly the contract transitions and rejects every other (status, action) pair", () => {
    for (const action of Object.keys(valid) as OrderAction[]) {
      for (const from of all) expect(nextStatus(from, action), `${from} --${action}-->`).toBe(valid[action][from] ?? null);
    }
  });

  it("treats every state after EDITING as confirmed", () => {
    expect(all.filter(isConfirmed)).toEqual(["CONFIRMED", "PREPARING", "READY", "DELIVERED", "CANCELLED"]);
  });
});

describe("priceItems (against the branch menu)", () => {
  const P = "00000000-0000-7000-8000-0000000000";
  const burger: MenuProductDto = {
    id: `${P}01`,
    categoryId: null,
    name: "X-Burger",
    description: null,
    code: "XB",
    price: "25.00",
    optionGroups: [
      { id: "g-size", name: "Tamanho", minChoices: 1, maxChoices: 1, sortOrder: 0, options: [{ id: `${P}11`, name: "P", priceDelta: "0.00", linkedProductId: null, sortOrder: 0 }, { id: `${P}12`, name: "G", priceDelta: "4.00", linkedProductId: null, sortOrder: 1 }] },
      { id: "g-extra", name: "Extras", minChoices: 0, maxChoices: 2, sortOrder: 1, options: [{ id: `${P}21`, name: "Bacon", priceDelta: "3.50", linkedProductId: null, sortOrder: 0 }, { id: `${P}22`, name: "Ovo", priceDelta: "2.00", linkedProductId: null, sortOrder: 1 }, { id: `${P}23`, name: "Refri", priceDelta: "0.00", linkedProductId: `${P}02`, sortOrder: 2 }] },
    ],
  };
  const candy: MenuProductDto = { id: `${P}03`, categoryId: null, name: "Bala", description: null, code: null, price: "0.10", optionGroups: [] };
  const menu: MenuDto = { branchId: "b", categories: [], products: [burger, candy] };
  const item = (productId: string, optionIds: string[] = [], quantity = 1, note: string | null = null): OrderItemValue => ({ productId, optionIds, quantity, note });

  it("prices = branch price + sum of priceDelta, line = unit × quantity, snapshot in menu order", () => {
    const result = priceItems([item(burger.id, [`${P}22`, `${P}12`, `${P}21`], 2, "sem cebola"), item(candy.id, [], 3)], menu);
    expect(result).toEqual({
      ok: true,
      total: "69.30",
      items: [
        {
          productId: burger.id,
          productName: "X-Burger",
          productCode: "XB",
          quantity: 2,
          unitPrice: "34.50",
          lineTotal: "69.00",
          note: "sem cebola",
          options: [
            { optionId: `${P}12`, groupName: "Tamanho", name: "G", priceDelta: "4.00", linkedProductId: null },
            { optionId: `${P}21`, groupName: "Extras", name: "Bacon", priceDelta: "3.50", linkedProductId: null },
            { optionId: `${P}22`, groupName: "Extras", name: "Ovo", priceDelta: "2.00", linkedProductId: null },
          ],
        },
        { productId: candy.id, productName: "Bala", productCode: null, quantity: 3, unitPrice: "0.10", lineTotal: "0.30", note: null, options: [] },
      ],
    });
    // (25.00 + 4.00 + 3.50 + 2.00) × 2 + 0.10 × 3 = 69.00 + 0.30 = 69.30, computed in cents.
    if (result.ok) expect(result.total).toBe(centsToMoney(moneyToCents("69.00") + moneyToCents("0.30")));
  });

  it("flags unavailable products and invalid choices with the item path", () => {
    const result = priceItems(
      [
        item(`${P}99`),
        item(burger.id, []), // required size missing (minChoices 1, zero chosen)
        item(burger.id, [`${P}11`, `${P}12`]), // two sizes, max 1
        item(burger.id, [`${P}11`, `${P}11`]), // repeated
        item(burger.id, [`${P}11`, `${P}03`]), // option of another product
        item(burger.id, [`${P}11`, `${P}21`, `${P}22`, `${P}23`]), // three extras, max 2
        item(burger.id, [`${P}11`, `${P}23`]), // ok (linked option still sellable)
      ],
      menu,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "items[0].productId", issue: "unavailable" },
        { field: "items[1].optionIds", issue: "invalid_choices" },
        { field: "items[2].optionIds", issue: "invalid_choices" },
        { field: "items[3].optionIds", issue: "invalid_choices" },
        { field: "items[4].optionIds", issue: "invalid_choices" },
        { field: "items[5].optionIds", issue: "invalid_choices" },
      ],
    });
  });

  it("refuses a total above numeric(12,2) and accepts exactly the maximum", () => {
    const big: MenuProductDto = { ...candy, id: `${P}04`, price: "9999999999.99" };
    const huge = { ...menu, products: [...menu.products, big] };
    expect(priceItems([item(big.id)], huge)).toMatchObject({ ok: true, total: "9999999999.99" });
    expect(priceItems([item(big.id), item(candy.id)], huge)).toEqual({ ok: false, overflow: true });
    expect(priceItems([item(big.id, [], 99)], huge)).toEqual({ ok: false, overflow: true });
  });
});

describe("order request parsing", () => {
  const parseItems = (items: unknown) => parseInput({ items }, { items: required(api.orderItems) }).items;
  const id = "0198A1B2-0000-7000-8000-000000000000";

  it("normalizes items: lowercase ids, default optionIds, trimmed note (empty = null)", () => {
    expect(parseItems([{ productId: id, quantity: 2, optionIds: [id], note: "  sem gelo " }, { productId: id, quantity: 1, note: "  " }])).toEqual([
      { productId: id.toLowerCase(), quantity: 2, optionIds: [id.toLowerCase()], note: "sem gelo" },
      { productId: id.toLowerCase(), quantity: 1, optionIds: [], note: null },
    ]);
  });

  it("validates quantity, note, ids, unknown fields and the 100-item limit with paths", () => {
    expect(
      issuesOf(() => parseItems([{ productId: "x", quantity: 100, note: "n".repeat(141), price: "1.00" }, { quantity: 1.5, optionIds: ["nope"] }])),
    ).toEqual([
      { field: "items[0].price", issue: "unknown_field" },
      { field: "items[0].productId", issue: "invalid_format" },
      { field: "items[0].quantity", issue: "invalid_value" },
      { field: "items[0].note", issue: "too_long" },
      { field: "items[1].productId", issue: "required" },
      { field: "items[1].quantity", issue: "invalid_type" },
      { field: "items[1].optionIds[0]", issue: "invalid_format" },
    ]);
    expect(issuesOf(() => parseItems([{ productId: id, quantity: 0 }]))).toEqual([{ field: "items[0].quantity", issue: "invalid_value" }]);
    expect(parseItems(Array.from({ length: 100 }, () => ({ productId: id, quantity: 1 })))).toHaveLength(100);
    expect(issuesOf(() => parseItems(Array.from({ length: 101 }, () => ({ productId: id, quantity: 1 }))))).toEqual([{ field: "items", issue: "too_many" }]);
  });

  it("parses the cancel reason, status list and business date", () => {
    expect(api.cancelReason("  ok! ")).toEqual({ ok: true, value: "ok!" });
    expect(api.cancelReason("ab ")).toEqual({ ok: false, issue: "too_short" });
    expect(api.cancelReason("x".repeat(201))).toEqual({ ok: false, issue: "too_long" });
    expect(api.cancelReason(5)).toEqual({ ok: false, issue: "invalid_type" });
    expect(api.statusList("CONFIRMED,PREPARING,CONFIRMED")).toEqual({ ok: true, value: ["CONFIRMED", "PREPARING"] });
    for (const raw of ["", "confirmed", "CONFIRMED,", "CONFIRMED, READY"]) expect(api.statusList(raw)).toEqual({ ok: false, issue: "invalid_value" });
    expect(api.statusList(["READY"])).toEqual({ ok: false, issue: "invalid_format" });
    expect(api.businessDateQuery("2026-11-09")).toEqual({ ok: true, value: "2026-11-09" });
    expect(api.businessDateQuery("2026-02-30")).toEqual({ ok: false, issue: "invalid_value" });
    expect(api.businessDateQuery("09/11/2026")).toEqual({ ok: false, issue: "invalid_format" });
  });
});
