import type { KitchenTicketStatus } from "@erp/contracts";
import { checked, int, type Parsed, type Parser } from "../http/input.js";
import { checkBranchCode } from "../organization/validation/branch-code.js";
import { SORT_ORDER_MAX } from "../products/validation.js";

/**
 * Limites publicados em `@erp/contracts` (kitchen.ts). Duplicados porque `apps/api` só pode usar `import type` dos
 * packages; `validation.test.ts` compara cada valor com o contrato.
 */
export const KITCHEN_SECTOR_NAME_MAX_LENGTH = 60;
export const KITCHEN_SECTOR_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const KITCHEN_TICKET_STATUSES = ["WAITING", "PREPARING", "READY", "CANCELLED"] as const;

/** Código do setor: mesmo formato e normalização de `products.code` (trim + maiúsculo, `^[A-Z0-9][A-Z0-9_-]{0,31}$`). */
export const sectorCode = checked((value): Parsed<string> => checkBranchCode(value));

export const sectorSortOrder = int(0, SORT_ORDER_MAX);

/** Query `status=WAITING,PREPARING`: um ou mais estados de `KITCHEN_TICKET_STATUSES`, sem vazios; repetidos ignorados. */
export const ticketStatusList: Parser<KitchenTicketStatus[]> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_format" };
  const values = raw.split(",");
  if (values.some((v) => !(KITCHEN_TICKET_STATUSES as readonly string[]).includes(v))) return { ok: false, issue: "invalid_value" };
  return { ok: true, value: [...new Set(values as KitchenTicketStatus[])] };
};
