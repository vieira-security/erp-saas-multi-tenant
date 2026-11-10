import type { Money } from "@erp/contracts";
import type { Parser } from "./input.js";

/**
 * Dinheiro na API (`Money` de `@erp/contracts`): string decimal em reais, ponto como separador, sempre 2 casas na
 * resposta. Nunca `number`/float — nem no parsing (sem `parseFloat`/`Number`), nem na resposta (`Decimal.toFixed(2)`).
 *
 * Mesmos valores de `MONEY_INPUT_PATTERN`/`MONEY_MAX` do contrato (um teste compara). O padrão já limita a 10 dígitos
 * inteiros, então todo valor aceito cabe em `numeric(12,2)` e é ≤ `MONEY_MAX`.
 */
export const MONEY_INPUT_PATTERN = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;
export const MONEY_MAX = "9999999999.99";

/**
 * Aceita `"12"`, `"12.5"`, `"12.50"` e devolve normalizado com 2 casas (`"12.50"`). Rejeita com `invalid_money`:
 * number (`12.5`), expoente (`"1e3"`), sinal (`"-1"`, `"+1"`), vírgula (`"1,50"`), espaços, zeros à esquerda, mais de
 * 2 casas ou mais de 10 dígitos inteiros. Manipulação só de texto: nenhuma conversão para ponto flutuante.
 */
export const money: Parser<Money> = (raw) => {
  if (typeof raw !== "string" || !MONEY_INPUT_PATTERN.test(raw)) return { ok: false, issue: "invalid_money" };
  const [integer, fraction = ""] = raw.split(".");
  return { ok: true, value: `${integer}.${fraction.padEnd(2, "0")}` };
};

/** Valor decimal do banco (Prisma `Decimal`, numeric(12,2)) -> `Money` com exatamente 2 casas. */
export function toMoney(value: { toFixed(decimals: number): string }): Money {
  return value.toFixed(2);
}

/** `MONEY_MAX` em centavos: maior valor de `numeric(12,2)`. */
export const MONEY_MAX_CENTS = 999_999_999_999n;

/**
 * `Money` já normalizado (`"12.50"`, como sai de `money`/`toMoney`) -> centavos inteiros (`1250n`). Aritmética de totais
 * é feita em `bigint` (sem ponto flutuante) e só volta a texto no fim (`centsToMoney`).
 */
export function moneyToCents(value: Money): bigint {
  const match = /^([0-9]+)\.([0-9]{2})$/.exec(value);
  if (!match) throw new Error(`not a normalized Money value: ${value}`);
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

export function centsToMoney(cents: bigint): Money {
  if (cents < 0n) throw new Error("negative money");
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}
