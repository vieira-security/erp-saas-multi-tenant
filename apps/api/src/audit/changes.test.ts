import { describe, expect, it } from "vitest";
import { UnsupportedAuditValueError, auditValue, diffChanges, hasChanges } from "./changes.js";

/** Stand-in for the Prisma `Decimal` (numeric(12,2) money): only `toFixed` matters. */
const decimal = (value: string) => ({ toFixed: (digits: number) => Number(value).toFixed(digits) });

describe("diffChanges (KAN-41 metadata.changes)", () => {
  it("records only the fields that changed, with money normalized to a 2-decimal string", () => {
    const before = { name: "X-Burger", basePrice: decimal("25"), sortOrder: 1 };
    const changes = diffChanges(before, { name: "X-Burger", basePrice: "27.00", sortOrder: 1 }, ["name", "basePrice", "sortOrder"]);
    expect(changes).toEqual({ basePrice: { from: "25.00", to: "27.00" } });
  });

  it("treats the same money as unchanged even when the database returns a Decimal", () => {
    expect(diffChanges({ price: decimal("27.5") }, { price: "27.50" }, ["price"])).toEqual({});
  });

  it("normalizes null and undefined (before) to null, and records null -> value and value -> null", () => {
    expect(diffChanges({ code: null }, { code: "XB" }, ["code"])).toEqual({ code: { from: null, to: "XB" } });
    expect(diffChanges({ code: "XB" }, { code: null }, ["code"])).toEqual({ code: { from: "XB", to: null } });
    expect(diffChanges({ code: undefined }, { code: null }, ["code"])).toEqual({});
    expect(diffChanges({ price: null }, { price: null }, ["price"])).toEqual({});
  });

  it("is empty when nothing changed, and skips fields absent from `after` (PATCH semantics)", () => {
    const before = { name: "A", sortOrder: 2, available: true };
    expect(diffChanges(before, { name: "A", sortOrder: 2 }, ["name", "sortOrder", "available"])).toEqual({});
    expect(diffChanges(before, {}, ["name", "sortOrder", "available"])).toEqual({});
    expect(diffChanges(before, { name: undefined }, ["name"])).toEqual({});
    expect(hasChanges(diffChanges(before, { name: "A" }, ["name"]))).toBe(false);
    expect(hasChanges(diffChanges(before, { available: false }, ["available"]))).toBe(true);
  });

  it("ignores fields not listed (never dumps the whole record)", () => {
    const before: Record<string, unknown> = { name: "A", passwordHash: "argon2id$..." };
    const after: Record<string, unknown> = { name: "B", passwordHash: "other" };
    expect(diffChanges<string>(before, after, ["name"])).toEqual({ name: { from: "A", to: "B" } });
  });

  it("normalizes dates to ISO, keeps booleans and integers, and rejects non-scalars", () => {
    const at = new Date("2026-11-10T12:00:00.000Z");
    expect(auditValue(at)).toBe("2026-11-10T12:00:00.000Z");
    expect(diffChanges({ at: new Date(at) }, { at }, ["at"])).toEqual({});
    expect(auditValue(false)).toBe(false);
    expect(auditValue(3)).toBe(3);
    expect(auditValue(5n)).toBe("5");
    for (const bad of [{ a: 1 }, [1], Number.NaN, () => 1]) expect(() => auditValue(bad, "f")).toThrow(UnsupportedAuditValueError);
  });
});
