import type { Money, ValidationIssue } from "@erp/contracts";
import { checked, int, list, nested, nullable, optional, required, text, uuid, type Parsed, type Parser } from "../http/input.js";
import { money } from "../http/money.js";
import { checkBranchCode } from "../organization/validation/branch-code.js";

/**
 * Limites publicados em `@erp/contracts` (products.ts). Duplicados aqui porque `apps/api` só pode usar `import type` dos
 * packages; `validation.test.ts` compara cada valor com o contrato.
 */
export const PRODUCT_NAME_MAX_LENGTH = 120;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 500;
export const PRODUCT_CATEGORY_NAME_MAX_LENGTH = 80;
export const OPTION_NAME_MAX_LENGTH = 80;
export const OPTION_GROUPS_MAX = 20;
export const OPTIONS_PER_GROUP_MAX = 50;
export const SORT_ORDER_MAX = 9999;
/** OptionGroupInput: minChoices 0–50, maxChoices 1–50. */
export const CHOICES_MAX = 50;
/** ListProductsQuery.q: 1–80 caracteres. */
export const PRODUCT_QUERY_MAX_LENGTH = 80;
export const STATUSES = ["ACTIVE", "INACTIVE"] as const;

export const sortOrder = int(0, SORT_ORDER_MAX);

/** Código do produto: mesmo formato e normalização de `Branch.code` (trim + maiúsculo, `BRANCH_CODE`). */
export const productCode = checked((value): Parsed<string> => checkBranchCode(value));

/** Descrição: aparada; vazia ou `null` = sem descrição; até 500 caracteres. */
export const description: Parser<string | null> = (raw) => {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  const value = raw.trim();
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > PRODUCT_DESCRIPTION_MAX_LENGTH) return { ok: false, issue: "too_long" };
  return { ok: true, value };
};

export interface OptionGroupValue {
  readonly name: string;
  readonly minChoices: number;
  readonly maxChoices: number;
  readonly options: readonly OptionValue[];
}

export interface OptionValue {
  readonly name: string;
  readonly priceDelta: Money;
  readonly linkedProductId: string | null;
}

const optionSpec = {
  name: required(text(OPTION_NAME_MAX_LENGTH)),
  priceDelta: optional(money),
  linkedProductId: optional(nullable(uuid)),
};

const groupSpec = {
  name: required(text(OPTION_NAME_MAX_LENGTH)),
  minChoices: required(int(0, CHOICES_MAX)),
  maxChoices: required(int(1, CHOICES_MAX)),
  options: required(list(nested(optionSpec), 1, OPTIONS_PER_GROUP_MAX)),
};

const parseGroup = nested(groupSpec);

/**
 * Um grupo (OptionGroupInput): campos estritos e, quando todos são válidos, `minChoices ≤ maxChoices ≤ nº de opções`
 * (`min_greater_than_max`, `max_greater_than_options`). `priceDelta` ausente = `"0.00"`; `linkedProductId` ausente = `null`.
 * Existência/estado do produto vinculado é regra de banco (service), não de formato.
 */
export const optionGroup: Parser<OptionGroupValue> = (raw) => {
  const parsed = parseGroup(raw);
  if (!parsed.ok) return parsed;
  const group = parsed.value;
  const issues: ValidationIssue[] = [];
  if (group.minChoices > group.maxChoices) issues.push({ field: ".minChoices", issue: "min_greater_than_max" });
  if (group.maxChoices > group.options.length) issues.push({ field: ".maxChoices", issue: "max_greater_than_options" });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      name: group.name,
      minChoices: group.minChoices,
      maxChoices: group.maxChoices,
      options: group.options.map((option) => ({
        name: option.name,
        priceDelta: option.priceDelta ?? "0.00",
        linkedProductId: option.linkedProductId ?? null,
      })),
    },
  };
};

/** Lista completa de grupos (até 20; vazia = sem grupos). A posição na lista vira o `sortOrder`. */
export const optionGroups = list(optionGroup, 0, OPTION_GROUPS_MAX);
