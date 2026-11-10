import type { OrderStatus } from "@erp/contracts";
import { int, list, nested, optional, required, uuid, type Parser } from "../http/input.js";
import { OPTION_GROUPS_MAX, OPTIONS_PER_GROUP_MAX } from "../products/validation.js";
import { isCalendarDate } from "./business-date.js";
import type { OrderItemValue } from "./pricing.js";

/**
 * Limites publicados em `@erp/contracts` (orders.ts). Duplicados porque `apps/api` só pode usar `import type` dos
 * packages; `validation.test.ts` compara cada valor com o contrato.
 */
export const ORDER_STATUSES = ["EDITING", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "CANCELLED"] as const;
export const ORDER_ITEMS_MAX = 100;
export const ORDER_ITEM_QUANTITY_MAX = 99;
export const ORDER_ITEM_NOTE_MAX_LENGTH = 140;
export const CANCEL_REASON_MIN_LENGTH = 3;
export const CANCEL_REASON_MAX_LENGTH = 200;
/** Teto técnico de `optionIds` por item: no máximo uma opção de cada (20 grupos × 50 opções, limites do M4). */
export const ORDER_ITEM_OPTION_IDS_MAX = OPTION_GROUPS_MAX * OPTIONS_PER_GROUP_MAX;

/** Observação: aparada; vazia ou `null` = sem observação; até 140 caracteres. */
const note: Parser<string | null> = (raw) => {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  const value = raw.trim();
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > ORDER_ITEM_NOTE_MAX_LENGTH) return { ok: false, issue: "too_long" };
  return { ok: true, value };
};

const parseItem = nested({
  productId: required(uuid),
  quantity: required(int(1, ORDER_ITEM_QUANTITY_MAX)),
  optionIds: optional(list(uuid, 0, ORDER_ITEM_OPTION_IDS_MAX)),
  note: optional(note),
});

/** Formato de um OrderItemInput (disponibilidade e escolhas por grupo são validadas contra o cardápio, em pricing.ts). */
const orderItem: Parser<OrderItemValue> = (raw) => {
  const parsed = parseItem(raw);
  if (!parsed.ok) return parsed;
  const { productId, quantity, optionIds, note: itemNote } = parsed.value;
  return { ok: true, value: { productId, quantity, optionIds: optionIds ?? [], note: itemNote ?? null } };
};

export const orderItems = list(orderItem, 0, ORDER_ITEMS_MAX);

/** Motivo do cancelamento: 3–200 caracteres após trim. */
export const cancelReason: Parser<string> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  const value = raw.trim();
  if (value.length < CANCEL_REASON_MIN_LENGTH) return { ok: false, issue: "too_short" };
  if (value.length > CANCEL_REASON_MAX_LENGTH) return { ok: false, issue: "too_long" };
  return { ok: true, value };
};

/** Query `status=CONFIRMED,PREPARING`: um ou mais estados do enum, sem vazios; repetidos são ignorados. */
export const statusList: Parser<OrderStatus[]> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_format" };
  const values = raw.split(",");
  if (values.some((v) => !(ORDER_STATUSES as readonly string[]).includes(v))) return { ok: false, issue: "invalid_value" };
  return { ok: true, value: [...new Set(values as OrderStatus[])] };
};

/** Query `businessDate=YYYY-MM-DD`, data de calendário real. */
export const businessDateQuery: Parser<string> = (raw) => {
  if (typeof raw !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw)) return { ok: false, issue: "invalid_format" };
  return isCalendarDate(raw) ? { ok: true, value: raw } : { ok: false, issue: "invalid_value" };
};
