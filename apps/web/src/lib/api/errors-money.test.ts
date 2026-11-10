import { describe, expect, it } from "vitest";
import { errorMessage, toApiError } from "./errors";
import { formatMoney } from "./money";

describe("toApiError", () => {
  it("keeps contract codes and valid details", () => {
    const error = toApiError(400, {
      error: "validation_failed",
      details: [
        { field: "pageSize", issue: "invalid_value" },
        { field: "x", issue: "made_up" },
      ],
    });
    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual([{ field: "pageSize", issue: "invalid_value" }]);
  });

  it("accepts auth codes", () => {
    expect(toApiError(403, { error: "forbidden_origin" }).code).toBe("forbidden_origin");
  });

  it("never trusts unknown codes or server text", () => {
    const error = toApiError(409, { error: "Internal: SELECT * FROM users", message: "stack trace" });
    expect(error.code).toBe("unexpected_error");
    expect(error.message).toBe("unexpected_error");
    expect(errorMessage(error.code)).not.toContain("SELECT");
  });

  it("maps statuses without a contract body", () => {
    expect(toApiError(401, undefined).code).toBe("unauthenticated");
    expect(toApiError(403, "<html>").code).toBe("forbidden");
    expect(toApiError(404, null).code).toBe("not_found");
    expect(toApiError(500, { error: "forbidden" }).code).toBe("unexpected_error");
  });

  it("has a pt-BR message for every code", () => {
    expect(errorMessage("forbidden")).toMatch(/permissão/);
    expect(errorMessage("insufficient_cash")).toBe("Não foi possível concluir a operação.");
  });
});

describe("formatMoney", () => {
  it("formats contract strings without float math", () => {
    expect(formatMoney("0.00")).toBe("R$ 0,00");
    expect(formatMoney("12.50")).toBe("R$ 12,50");
    expect(formatMoney("1234567.89")).toBe("R$ 1.234.567,89");
    expect(formatMoney("9999999999.99")).toBe("R$ 9.999.999.999,99");
    expect(formatMoney("-5.00")).toBe("-R$ 5,00");
    expect(formatMoney("0.10")).toBe("R$ 0,10");
  });

  it("rejects values outside the contract format", () => {
    expect(formatMoney("12.5")).toBe("—");
    expect(formatMoney("1e3")).toBe("—");
    expect(formatMoney("12,50")).toBe("—");
  });
});
