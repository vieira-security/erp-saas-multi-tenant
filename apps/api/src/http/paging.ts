import type { Page } from "@erp/contracts";
import { optional, queryInt } from "./input.js";

/** Mesmos valores de `PAGE_SIZE_DEFAULT`/`PAGE_SIZE_MAX` em `@erp/contracts` (um teste compara). */
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;
/** Teto de página para não gerar OFFSET gigante. */
const PAGE_MAX = 100_000;

export const pageQuerySpec = { page: optional(queryInt(PAGE_MAX)), pageSize: optional(queryInt(PAGE_SIZE_MAX)) };

export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
  readonly skip: number;
  readonly take: number;
}

export function pageRequest(query: { page?: number; pageSize?: number }): PageRequest {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? PAGE_SIZE_DEFAULT;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function toPage<T, R>(rows: readonly T[], total: number, request: PageRequest, map: (row: T) => R): Page<R> {
  return {
    items: rows.map(map),
    page: request.page,
    pageSize: request.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / request.pageSize),
  };
}
