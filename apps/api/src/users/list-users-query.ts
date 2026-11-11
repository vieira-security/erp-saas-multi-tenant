import type { UserStatus } from "@erp/contracts";
import { oneOf, optional, parseInput, text } from "../http/input.js";
import { pageQuerySpec, pageRequest, type PageRequest } from "../http/paging.js";

/** Mesmos valores de `USER_STATUSES` do contrato; os dois tipos abaixo fazem o typecheck falhar se divergirem. */
const USER_STATUSES = ["ACTIVE", "DISABLED", "LOCKED"] as const satisfies readonly UserStatus[];
type MissingStatus = Exclude<UserStatus, (typeof USER_STATUSES)[number]>;
const statusesMatchContract: [MissingStatus] extends [never] ? true : never = true;
void statusesMatchContract;

/** Limite publicado no contrato (`ListUsersQuery.search`: 1–100 caracteres após trim). */
export const USER_SEARCH_MAX = 100;

export const listUsersQuerySpec = {
  ...pageQuerySpec,
  status: optional(oneOf(USER_STATUSES)),
  search: optional(text(USER_SEARCH_MAX)),
};

export interface UserListFilter {
  readonly status?: UserStatus;
  /** Termo já aparado (1..100). */
  readonly search?: string;
}

/**
 * Query de `GET /users` com o parser estrito de sempre: campo desconhecido (inclusive `tenantId`) = `unknown_field`,
 * `status` fora de `USER_STATUSES` = `invalid_value`, `search` vazio após trim = `too_short`, acima de 100 = `too_long`,
 * paginação com os mesmos limites das outras listagens.
 */
export function parseListUsersQuery(query: unknown): { filter: UserListFilter; page: PageRequest } {
  const { status, search, ...paging } = parseInput(query, listUsersQuerySpec, "query");
  return { filter: { ...(status ? { status } : {}), ...(search ? { search } : {}) }, page: pageRequest(paging) };
}

/**
 * Padrão `ILIKE` "contém" com o termo tratado como texto literal: `\`, `%` e `_` do termo são escapados (o SQL usa
 * `ESCAPE '\'`). O padrão vai como parâmetro, nunca concatenado no SQL.
 */
export function likeContainsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
