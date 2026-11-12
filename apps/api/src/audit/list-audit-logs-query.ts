import type { AuditAction } from "@erp/contracts";
import { ValidationFailedError } from "../http/api-error.js";
import { optional, parseInput, uuid, type Parser } from "../http/input.js";
import { AUDIT_ACTION_CATALOG } from "./audit-catalog.js";
import { pageQuerySpec, pageRequest, type PageRequest } from "../http/paging.js";

/**
 * Instante ISO 8601 COM fuso (`Z` ou `±hh:mm`), segundos e milissegundos opcionais. Sem fuso = `invalid_format`: o
 * servidor não adivinha o fuso de quem consulta. Data de calendário impossível (`2026-02-30`) = `invalid_value` (o
 * `Date` do JavaScript "rolaria" para março).
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export const isoInstant: Parser<Date> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  const match = ISO_INSTANT.exec(raw);
  if (!match) return { ok: false, issue: "invalid_format" };
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? "0")) as [number, number, number, number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const sameCalendar =
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
  const instant = new Date(raw);
  if (!sameCalendar || Number.isNaN(instant.getTime())) return { ok: false, issue: "invalid_value" };
  return { ok: true, value: instant };
};

const CATALOG: ReadonlySet<string> = new Set(AUDIT_ACTION_CATALOG);

/** `action=a,b`: ações do catálogo separadas por vírgula, sem espaços nem itens vazios; repetidas contam uma vez. */
export const auditActionList: Parser<AuditAction[]> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  const items = raw.split(",");
  if (items.some((item) => !CATALOG.has(item))) return { ok: false, issue: "invalid_value" };
  return { ok: true, value: [...new Set(items)] as AuditAction[] };
};

/** Mesmo formato do CHECK `audit_logs_resource_type_check` (identificador técnico), até 64 caracteres. */
const RESOURCE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

export const resourceType: Parser<string> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  return RESOURCE_TYPE.test(raw) ? { ok: true, value: raw } : { ok: false, issue: "invalid_format" };
};

export const listAuditLogsQuerySpec = {
  ...pageQuerySpec,
  from: optional(isoInstant),
  to: optional(isoInstant),
  action: optional(auditActionList),
  userId: optional(uuid),
  branchId: optional(uuid),
  resourceType: optional(resourceType),
  resourceId: optional(uuid),
};

export interface AuditLogFilter {
  /** Inclusivo. */
  readonly from?: Date;
  /** Exclusivo. */
  readonly to?: Date;
  readonly actions?: readonly AuditAction[];
  readonly userId?: string;
  readonly branchId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

/**
 * Query de `GET /audit-logs` (contrato `ListAuditLogsQuery`), estrita como as demais: campo desconhecido (inclusive
 * `tenantId`) = `unknown_field`; datas inválidas; `from` depois de `to` = `invalid_value` em `from`; ação fora do
 * catálogo = `invalid_value`; ids fora do formato UUID = `invalid_format`. Paginação com os limites de sempre (máx. 100).
 */
export function parseListAuditLogsQuery(query: unknown): { filter: AuditLogFilter; page: PageRequest } {
  const { from, to, action, userId, branchId, resourceType: type, resourceId, ...paging } = parseInput(query, listAuditLogsQuerySpec, "query");
  if (from && to && from.getTime() > to.getTime()) throw new ValidationFailedError([{ field: "from", issue: "invalid_value" }]);
  return {
    filter: {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(action ? { actions: action } : {}),
      ...(userId ? { userId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(type ? { resourceType: type } : {}),
      ...(resourceId ? { resourceId } : {}),
    },
    page: pageRequest(paging),
  };
}
