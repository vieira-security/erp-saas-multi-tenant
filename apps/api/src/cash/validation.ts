import type { CashMovementType, Money, PaymentMethod } from "@erp/contracts";
import { list, nested, nullable, oneOf, optional, required, type Parser } from "../http/input.js";
import { money, moneyToCents } from "../http/money.js";

/**
 * Valores publicados em `@erp/contracts` (cash.ts). Duplicados porque `apps/api` só pode usar `import type` dos packages;
 * `cash.test.ts` compara cada valor com o contrato.
 */
export const PAYMENT_METHODS = ["CASH", "PIX", "DEBIT_CARD", "CREDIT_CARD"] as const;
export const CASH_SESSION_STATUSES = ["OPEN", "CLOSED"] as const;
export const CASH_MOVEMENT_TYPES = ["SUPPLY", "WITHDRAWAL"] as const;
export const PAYMENT_REFERENCE_MAX_LENGTH = 60;
export const CASH_MOVEMENT_REASON_MIN_LENGTH = 3;
export const CASH_MOVEMENT_REASON_MAX_LENGTH = 200;
export const CASH_JUSTIFICATION_MIN_LENGTH = 3;
export const CASH_JUSTIFICATION_MAX_LENGTH = 500;
export const PAYMENTS_PER_ORDER_MAX = 10;

/** Dinheiro estritamente positivo (`"0"` = `invalid_value`). */
export const positiveMoney: Parser<Money> = (raw) => {
  const parsed = money(raw);
  if (!parsed.ok) return parsed;
  return moneyToCents(parsed.value) > 0n ? parsed : { ok: false, issue: "invalid_value" };
};

/** Texto aparado com tamanho `min..max` (`too_short`/`too_long`). */
export function boundedText(min: number, max: number): Parser<string> {
  return (raw) => {
    if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
    const value = raw.trim();
    if (value.length < min) return { ok: false, issue: "too_short" };
    if (value.length > max) return { ok: false, issue: "too_long" };
    return { ok: true, value };
  };
}

/** Referência (NSU, autorização, id do PIX): 1–60 após trim; `null`/vazia = sem referência. */
const reference: Parser<string | null> = (raw) => {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  const value = raw.trim();
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > PAYMENT_REFERENCE_MAX_LENGTH) return { ok: false, issue: "too_long" };
  return { ok: true, value };
};

export interface PaymentValue {
  readonly method: PaymentMethod;
  readonly amount: Money;
  /** Só CASH. */
  readonly receivedAmount: Money | null;
  readonly reference: string | null;
}

const parsePayment = nested({
  method: required(oneOf(PAYMENT_METHODS)),
  amount: required(positiveMoney),
  receivedAmount: optional(money),
  reference: optional(nullable(reference)),
});

/**
 * Um PaymentInput: CASH exige `receivedAmount` ≥ `amount` (`required` / `invalid_value`); os demais métodos não aceitam
 * `receivedAmount` (`invalid_value`). A soma contra o total é regra da confirmação (cash-math.ts), não de formato.
 */
export const payment: Parser<PaymentValue> = (raw) => {
  const parsed = parsePayment(raw);
  if (!parsed.ok) return parsed;
  const { method, amount, receivedAmount, reference: ref } = parsed.value;
  if (method === "CASH") {
    if (receivedAmount === undefined) return { ok: false, issues: [{ field: ".receivedAmount", issue: "required" }] };
    if (moneyToCents(receivedAmount) < moneyToCents(amount)) return { ok: false, issues: [{ field: ".receivedAmount", issue: "invalid_value" }] };
  } else if (receivedAmount !== undefined) {
    return { ok: false, issues: [{ field: ".receivedAmount", issue: "invalid_value" }] };
  }
  return { ok: true, value: { method, amount, receivedAmount: receivedAmount ?? null, reference: ref ?? null } };
};

/** 0–10 pagamentos (split). */
export const payments = list(payment, 0, PAYMENTS_PER_ORDER_MAX);

export const movementType = oneOf<CashMovementType>(CASH_MOVEMENT_TYPES);
export const movementReason = boundedText(CASH_MOVEMENT_REASON_MIN_LENGTH, CASH_MOVEMENT_REASON_MAX_LENGTH);
/** Justificativa do fechamento: 3–500; `null`/vazia = sem justificativa. */
export const justification: Parser<string | null> = (raw) => {
  if (raw === null || (typeof raw === "string" && raw.trim().length === 0)) return { ok: true, value: null };
  return boundedText(CASH_JUSTIFICATION_MIN_LENGTH, CASH_JUSTIFICATION_MAX_LENGTH)(raw);
};
