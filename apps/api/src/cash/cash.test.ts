import * as contract from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { parseInput, required } from "../http/input.js";
import { changeOf, closingDifference, paymentsMatchTotal, signedMoney, sumMoney, summarizeSession } from "./cash-math.js";
import * as api from "./validation.js";
import type { PaymentValue } from "./validation.js";

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

describe("M6 constants", () => {
  it("match the values published in @erp/contracts", () => {
    expect(api.PAYMENT_METHODS).toEqual(contract.PAYMENT_METHODS);
    expect(api.CASH_SESSION_STATUSES).toEqual(contract.CASH_SESSION_STATUSES);
    expect(api.CASH_MOVEMENT_TYPES).toEqual(contract.CASH_MOVEMENT_TYPES);
    expect([
      api.PAYMENT_REFERENCE_MAX_LENGTH,
      api.CASH_MOVEMENT_REASON_MIN_LENGTH,
      api.CASH_MOVEMENT_REASON_MAX_LENGTH,
      api.CASH_JUSTIFICATION_MIN_LENGTH,
      api.CASH_JUSTIFICATION_MAX_LENGTH,
      api.PAYMENTS_PER_ORDER_MAX,
    ]).toEqual([
      contract.PAYMENT_REFERENCE_MAX_LENGTH,
      contract.CASH_MOVEMENT_REASON_MIN_LENGTH,
      contract.CASH_MOVEMENT_REASON_MAX_LENGTH,
      contract.CASH_JUSTIFICATION_MIN_LENGTH,
      contract.CASH_JUSTIFICATION_MAX_LENGTH,
      contract.PAYMENTS_PER_ORDER_MAX,
    ]);
  });

  it("only uses error codes published in the contract", () => {
    for (const code of ["cash_session_required", "cash_session_already_open", "cash_session_closed", "insufficient_cash", "payment_total_mismatch"]) {
      expect(contract.API_ERROR_CODES).toContain(code);
    }
  });
});

describe("expected cash and totals per method (bigint cents)", () => {
  it("opening + supply − withdrawal + cash received − change − cash refunds; other methods only reported", () => {
    // Cash payments are stored as amount = received − change (e.g. received 50.00 for 32.50 -> amount 32.50, change 17.50).
    const summary = summarizeSession({
      openingAmount: "100.00",
      payments: [
        { method: "CASH", amount: "32.50" },
        { method: "CASH", amount: "0.10" },
        { method: "CASH", amount: "0.20" },
        { method: "PIX", amount: "20.00" },
        { method: "CREDIT_CARD", amount: "15.90" },
      ],
      refunds: [{ method: "CASH", amount: "0.20" }],
      movements: [
        { type: "SUPPLY", amount: "50.00" },
        { type: "WITHDRAWAL", amount: "80.00" },
      ],
    });
    expect(summary.expectedCash).toBe("102.60"); // 100 + 50 − 80 + 32.50 + 0.10 + 0.20 − 0.20
    expect(summary.expectedCashCents).toBe(10260n);
    expect(summary.totals).toEqual([
      { method: "CASH", net: "32.60" },
      { method: "PIX", net: "20.00" },
      { method: "DEBIT_CARD", net: "0.00" },
      { method: "CREDIT_CARD", net: "15.90" },
    ]);
  });

  it("adds thousands of small values exactly (0.10 + 0.20 is 0.30, never 0.30000000000000004)", () => {
    const payments = Array.from({ length: 3000 }, (_, i) => ({ method: "CASH" as const, amount: i % 2 === 0 ? "0.10" : "0.20" }));
    expect(summarizeSession({ openingAmount: "0.00", payments, refunds: [], movements: [] }).expectedCash).toBe("450.00");
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
  });

  it("reports the closing difference with sign (counted − expected)", () => {
    expect(closingDifference("95.00", 10000n)).toEqual({ cents: -500n, money: "-5.00" });
    expect(closingDifference("100.01", 10000n)).toEqual({ cents: 1n, money: "0.01" });
    expect(closingDifference("100.00", 10000n)).toEqual({ cents: 0n, money: "0.00" });
    expect(signedMoney(-1n)).toBe("-0.01");
  });

  it("refuses an impossible negative expected cash (bug guard)", () => {
    expect(() => summarizeSession({ openingAmount: "0.00", payments: [], refunds: [], movements: [{ type: "WITHDRAWAL", amount: "0.01" }] })).toThrow();
  });
});

describe("payments", () => {
  const parse = (payments: unknown) => parseInput({ payments }, { payments: required(api.payments) }).payments;
  const cash = (amount: string, receivedAmount: string): PaymentValue => ({ method: "CASH", amount, receivedAmount, reference: null });
  const pix = (amount: string): PaymentValue => ({ method: "PIX", amount, receivedAmount: null, reference: null });

  it("computes change only for CASH", () => {
    expect(changeOf(cash("32.50", "50.00"))).toBe("17.50");
    expect(changeOf(cash("10.00", "10.00"))).toBe("0.00");
    expect(changeOf(pix("10.00"))).toBe("0.00");
  });

  it("requires the exact total (split allowed; empty list only for 0.00)", () => {
    expect(paymentsMatchTotal([cash("0.10", "1.00"), pix("0.20")], "0.30")).toBe(true);
    expect(paymentsMatchTotal([pix("0.30")], "0.31")).toBe(false);
    expect(paymentsMatchTotal([], "0.00")).toBe(true);
    expect(paymentsMatchTotal([], "0.01")).toBe(false);
  });

  it("parses methods, amounts, received amount and reference with paths", () => {
    expect(parse([{ method: "CASH", amount: "32.5", receivedAmount: "50" }, { method: "PIX", amount: "10", reference: "  E2E123 " }, { method: "DEBIT_CARD", amount: "1", reference: "" }])).toEqual([
      { method: "CASH", amount: "32.50", receivedAmount: "50.00", reference: null },
      { method: "PIX", amount: "10.00", receivedAmount: null, reference: "E2E123" },
      { method: "DEBIT_CARD", amount: "1.00", receivedAmount: null, reference: null },
    ]);
    expect(
      issuesOf(() =>
        parse([
          { method: "CASH", amount: "10.00" },
          { method: "CASH", amount: "10.00", receivedAmount: "9.99" },
          { method: "PIX", amount: "10.00", receivedAmount: "10.00" },
          { method: "BOLETO", amount: "0", reference: "x".repeat(61), tip: "1" },
          { method: "CREDIT_CARD", amount: 10 },
        ]),
      ),
    ).toEqual([
      { field: "payments[0].receivedAmount", issue: "required" },
      { field: "payments[1].receivedAmount", issue: "invalid_value" },
      { field: "payments[2].receivedAmount", issue: "invalid_value" },
      { field: "payments[3].tip", issue: "unknown_field" },
      { field: "payments[3].method", issue: "invalid_value" },
      { field: "payments[3].amount", issue: "invalid_value" },
      { field: "payments[3].reference", issue: "too_long" },
      { field: "payments[4].amount", issue: "invalid_money" },
    ]);
    expect(parse(Array.from({ length: 10 }, () => ({ method: "PIX", amount: "1" })))).toHaveLength(10);
    expect(issuesOf(() => parse(Array.from({ length: 11 }, () => ({ method: "PIX", amount: "1" }))))).toEqual([{ field: "payments", issue: "too_many" }]);
  });

  it("parses movement reason and closing justification", () => {
    expect(api.movementReason(" troco ")).toEqual({ ok: true, value: "troco" });
    expect(api.movementReason("ab")).toEqual({ ok: false, issue: "too_short" });
    expect(api.movementReason("x".repeat(201))).toEqual({ ok: false, issue: "too_long" });
    expect(api.justification(null)).toEqual({ ok: true, value: null });
    expect(api.justification("  ")).toEqual({ ok: true, value: null });
    expect(api.justification("ab")).toEqual({ ok: false, issue: "too_short" });
    expect(api.justification("x".repeat(501))).toEqual({ ok: false, issue: "too_long" });
    expect(api.positiveMoney("0")).toEqual({ ok: false, issue: "invalid_value" });
    expect(api.positiveMoney("0.01")).toEqual({ ok: true, value: "0.01" });
  });
});
