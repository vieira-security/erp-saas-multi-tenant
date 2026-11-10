import type { CashMethodTotalDto, CashMovementType, Money, PaymentMethod } from "@erp/contracts";
import { centsToMoney, moneyToCents } from "../http/money.js";
import { PAYMENT_METHODS, type PaymentValue } from "./validation.js";

/**
 * Contas do caixa e dos pagamentos — funções PURAS, em centavos `bigint` (nunca ponto flutuante).
 *
 * Valor esperado em DINHEIRO (contrato cash.ts):
 *   abertura + suprimentos − sangrias + recebido em dinheiro − troco dado − estornos em dinheiro.
 * Como `payments.amount` em CASH já é `recebido − troco`, isso é: abertura + suprimentos − sangrias + Σ amount(CASH) −
 * Σ estornos(CASH deste caixa).
 * Totais por método: recebido menos estornado NESTE caixa (estornos de PIX/cartão não têm caixa: devolução manual).
 */

export interface SessionLedger {
  readonly openingAmount: Money;
  readonly payments: readonly { readonly method: PaymentMethod; readonly amount: Money }[];
  /** Estornos lançados NESTE caixa (só CASH têm caixa). */
  readonly refunds: readonly { readonly method: PaymentMethod; readonly amount: Money }[];
  readonly movements: readonly { readonly type: CashMovementType; readonly amount: Money }[];
}

export interface SessionSummary {
  readonly expectedCash: Money;
  readonly expectedCashCents: bigint;
  readonly totals: readonly CashMethodTotalDto[];
}

function sum(values: readonly { readonly amount: Money }[]): bigint {
  return values.reduce((total, v) => total + moneyToCents(v.amount), 0n);
}

export function summarizeSession(ledger: SessionLedger): SessionSummary {
  const net = (method: PaymentMethod) =>
    sum(ledger.payments.filter((p) => p.method === method)) - sum(ledger.refunds.filter((r) => r.method === method));
  const supplies = sum(ledger.movements.filter((m) => m.type === "SUPPLY"));
  const withdrawals = sum(ledger.movements.filter((m) => m.type === "WITHDRAWAL"));
  const expected = moneyToCents(ledger.openingAmount) + supplies - withdrawals + net("CASH");
  // As travas mantêm o esperado ≥ 0: sangria ≤ esperado e estorno em dinheiro ≤ esperado do caixa de QUEM CANCELA (que
  // não é o caixa da venda). Negativo seria bug.
  if (expected < 0n) throw new Error("expected cash cannot be negative");
  return {
    expectedCash: centsToMoney(expected),
    expectedCashCents: expected,
    totals: PAYMENT_METHODS.map((method) => ({ method, net: signedMoney(net(method)) })),
  };
}

/** `Money` com sinal (só `difference` e totais líquidos podem ser negativos). */
export function signedMoney(cents: bigint): Money {
  return cents < 0n ? `-${centsToMoney(-cents)}` : centsToMoney(cents);
}

/** Diferença do fechamento: contado − esperado (negativa = falta). */
export function closingDifference(counted: Money, expectedCents: bigint): { cents: bigint; money: Money } {
  const cents = moneyToCents(counted) - expectedCents;
  return { cents, money: signedMoney(cents) };
}

/** Troco de um pagamento: recebido − valor em CASH; zero nos demais. */
export function changeOf(p: PaymentValue): Money {
  if (p.method !== "CASH" || p.receivedAmount === null) return "0.00";
  return centsToMoney(moneyToCents(p.receivedAmount) - moneyToCents(p.amount));
}

/** A soma dos `amount` tem que ser IGUAL ao total (lista vazia só para total `"0.00"`). */
export function paymentsMatchTotal(payments: readonly PaymentValue[], total: Money): boolean {
  return sum(payments) === moneyToCents(total);
}

/** Soma de valores `Money` (ex.: troco dado num pedido). */
export function sumMoney(values: readonly Money[]): Money {
  return centsToMoney(values.reduce((total, v) => total + moneyToCents(v), 0n));
}
