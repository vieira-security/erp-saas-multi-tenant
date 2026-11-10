import type { Money } from "@erp/contracts";

const MONEY_PATTERN = /^(-?)(\d+)\.(\d{2})$/;

/**
 * Exibe um `Money` da API (`"1234.50"`) como `R$ 1.234,50`, só manipulando texto: o cliente nunca converte valor
 * monetário para number nem calcula total (a API é a fonte dos valores). Fora do formato do contrato = `—`.
 */
export function formatMoney(value: Money): string {
  const match = MONEY_PATTERN.exec(value);
  if (!match) return "—";
  const [, sign, integer = "", cents = ""] = match;
  const grouped = integer.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign === "-" ? "-" : ""}R$ ${grouped},${cents}`;
}
