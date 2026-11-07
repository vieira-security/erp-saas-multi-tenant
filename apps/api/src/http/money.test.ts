import { MONEY_INPUT_PATTERN as CONTRACT_PATTERN, MONEY_MAX as CONTRACT_MAX } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { MONEY_INPUT_PATTERN, MONEY_MAX, money, toMoney } from "./money.js";

describe("money", () => {
  it("matches the pattern and maximum published in @erp/contracts", () => {
    expect(MONEY_INPUT_PATTERN.source).toBe(CONTRACT_PATTERN.source);
    expect(MONEY_INPUT_PATTERN.flags).toBe(CONTRACT_PATTERN.flags);
    expect(MONEY_MAX).toBe(CONTRACT_MAX);
  });

  it.each([
    ["0", "0.00"],
    ["0.1", "0.10"],
    ["0.10", "0.10"],
    ["12", "12.00"],
    ["12.5", "12.50"],
    ["12.50", "12.50"],
    ["9999999999.99", "9999999999.99"],
    ["1000000000", "1000000000.00"],
  ])("accepts %j as %j", (input, value) => {
    expect(money(input)).toEqual({ ok: true, value });
  });

  it.each([
    ["number", 12.5],
    ["integer number", 12],
    ["null", null],
    ["boolean", true],
    ["object", { amount: "1" }],
    ["11 integer digits", "10000000000"],
    ["exponent", "1e3"],
    ["negative", "-1"],
    ["explicit plus", "+1"],
    ["comma", "1,50"],
    ["three decimals", "1.005"],
    ["leading zero", "01.00"],
    ["trailing dot", "1."],
    ["leading dot", ".5"],
    ["spaces", " 1.00"],
    ["empty", ""],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["thousands separator", "1.000,00"],
    ["non-ASCII digits", "١٢"],
  ])("rejects %s with invalid_money", (_, input) => {
    expect(money(input)).toEqual({ ok: false, issue: "invalid_money" });
  });

  it("formats database decimals with exactly 2 places and without float drift", () => {
    expect(toMoney(new Prisma.Decimal("0"))).toBe("0.00");
    expect(toMoney(new Prisma.Decimal("12.5"))).toBe("12.50");
    expect(toMoney(new Prisma.Decimal("9999999999.99"))).toBe("9999999999.99");
    expect(toMoney(new Prisma.Decimal("0.10").plus(new Prisma.Decimal("0.20")))).toBe("0.30");
    // The same sum in binary floating point is not 0.30: the reason Money is never a number.
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});
