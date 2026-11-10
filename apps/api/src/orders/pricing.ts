import type { MenuDto, Money, ValidationIssue } from "@erp/contracts";
import { MONEY_MAX_CENTS, centsToMoney, moneyToCents } from "../http/money.js";

/**
 * Validação e preço dos itens a partir do CARDÁPIO DA FILIAL (`MenuDto` do M4, montado por menu.ts): o que o cardápio
 * mostra é exatamente o que se pode vender — produto ACTIVE e disponível na filial, preço efetivo, grupos e opções já
 * filtrados (combo com vinculado indisponível fora; `maxChoices` limitado às opções restantes). Nenhuma regra de
 * disponibilidade é repetida aqui. Função pura; dinheiro em centavos `bigint` (sem ponto flutuante).
 */

export interface OrderItemValue {
  readonly productId: string;
  readonly quantity: number;
  readonly optionIds: readonly string[];
  readonly note: string | null;
}

export interface PricedOption {
  readonly optionId: string;
  readonly groupName: string;
  readonly name: string;
  readonly priceDelta: Money;
  readonly linkedProductId: string | null;
}

export interface PricedItem {
  readonly productId: string;
  readonly productName: string;
  readonly productCode: string | null;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
  readonly note: string | null;
  /** Na ordem do cardápio (grupo, depois opção). */
  readonly options: readonly PricedOption[];
}

export type PricingResult =
  | { readonly ok: true; readonly items: readonly PricedItem[]; readonly total: Money }
  /** Itens não vendáveis/escolhas inválidas, com caminho (`items[2].optionIds`). */
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }
  /** Total acima de `numeric(12,2)` (`MONEY_MAX`). */
  | { readonly ok: false; readonly overflow: true };

export function priceItems(items: readonly OrderItemValue[], menu: MenuDto): PricingResult {
  const products = new Map(menu.products.map((p) => [p.id, p]));
  const issues: ValidationIssue[] = [];
  const priced: PricedItem[] = [];
  let total = 0n;

  items.forEach((item, index) => {
    const product = products.get(item.productId);
    if (!product) {
      issues.push({ field: `items[${index}].productId`, issue: "unavailable" });
      return;
    }
    const chosen = new Set(item.optionIds);
    const known = new Set(product.optionGroups.flatMap((g) => g.options.map((o) => o.id)));
    const choicesOk =
      chosen.size === item.optionIds.length &&
      item.optionIds.every((id) => known.has(id)) &&
      product.optionGroups.every((group) => {
        const count = group.options.filter((o) => chosen.has(o.id)).length;
        return count >= group.minChoices && count <= group.maxChoices;
      });
    if (!choicesOk) {
      issues.push({ field: `items[${index}].optionIds`, issue: "invalid_choices" });
      return;
    }
    const options: PricedOption[] = product.optionGroups.flatMap((group) =>
      group.options
        .filter((o) => chosen.has(o.id))
        .map((o) => ({ optionId: o.id, groupName: group.name, name: o.name, priceDelta: o.priceDelta, linkedProductId: o.linkedProductId })),
    );
    const unit = options.reduce((sum, o) => sum + moneyToCents(o.priceDelta), moneyToCents(product.price));
    const line = unit * BigInt(item.quantity);
    total += line;
    priced.push({
      productId: product.id,
      productName: product.name,
      productCode: product.code,
      quantity: item.quantity,
      unitPrice: centsToMoney(unit),
      lineTotal: centsToMoney(line),
      note: item.note,
      options,
    });
  });

  if (issues.length > 0) return { ok: false, issues };
  // Valores não negativos: total dentro do limite garante linha e preço unitário dentro do limite.
  if (total > MONEY_MAX_CENTS) return { ok: false, overflow: true };
  return { ok: true, items: priced, total: centsToMoney(total) };
}
