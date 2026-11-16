/**
 * Convenções HTTP compartilhadas entre `apps/api` e `apps/web`.
 *
 * Regras gerais (valem para todos os contratos deste pacote):
 * - IDs são UUID em texto; datas são ISO 8601 em UTC (`2026-11-07T15:00:00.000Z`).
 * - O tenant NUNCA aparece em request: vem do access token. Qualquer campo desconhecido no corpo (inclusive `tenantId`)
 *   é rejeitado com `validation_failed` / `unknown_field`.
 * - Strings de texto livre são aparadas (trim) pela API antes de validar e gravar.
 * - Autenticação: `Authorization: Bearer <accessToken>` em todas as rotas deste pacote.
 */

/** Códigos de erro públicos estáveis. O frontend decide a mensagem pelo código, nunca por texto do servidor. */
export const API_ERROR_CODES = [
  // 400
  "validation_failed",
  // 401
  "unauthenticated",
  // 403
  "forbidden",
  "password_change_required",
  "tenant_unavailable",
  // 404: recurso inexistente OU de outro tenant (indistinguíveis de propósito)
  "not_found",
  // 409
  "company_cnpj_already_exists",
  "company_inactive",
  "company_has_active_branches",
  "branch_code_already_exists",
  "branch_cnpj_already_exists",
  "branch_inactive",
  "branch_access_in_use",
  // M4
  "product_code_already_exists",
  "linked_product_invalid",
  // M5
  "order_not_editable",
  "order_invalid_transition",
  "order_empty",
  "order_item_unavailable",
  // M6
  "cash_session_required",
  "cash_session_already_open",
  "cash_session_closed",
  "insufficient_cash",
  "payment_total_mismatch",
  // Funcionários
  "employee_number_already_exists",
  "cannot_target_self",
  "last_owner_required",
  "user_has_open_cash_session",
  "role_inactive",
  "branch_access_required",
  // M7
  "kitchen_sector_code_already_exists",
  "kitchen_sector_default_required",
  "kitchen_sector_inactive",
  "kitchen_ticket_invalid_transition",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Motivo de cada campo inválido em `validation_failed`. */
export const VALIDATION_ISSUE_CODES = [
  "required",
  "invalid_type",
  "too_short",
  "too_long",
  "invalid_format",
  "invalid_value",
  "invalid_cnpj",
  "invalid_timezone",
  "cnpj_root_mismatch",
  "unknown_field",
  // M4
  "invalid_money",
  "min_greater_than_max",
  "max_greater_than_options",
  "too_many",
  "too_few",
  // M5
  "unavailable",
  "invalid_choices",
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export interface ValidationIssue {
  /** Nome do campo do corpo ou da query (ex.: `cnpj`, `pageSize`). */
  readonly field: string;
  readonly issue: ValidationIssueCode;
}

/** Corpo de toda resposta de erro (4xx). `details` só aparece em `validation_failed` e em `order_item_unavailable` (M5). */
export interface ApiErrorResponse {
  readonly error: ApiErrorCode;
  readonly details?: readonly ValidationIssue[];
}

/** Paginação por página (1-based). Ordem das listagens: data de criação crescente (estável). */
export interface PageQuery {
  /** Default 1. */
  readonly page?: number;
  /** Default 20, máximo 100. */
  readonly pageSize?: number;
}

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  /** Total de itens que atendem ao filtro (todas as páginas). */
  readonly total: number;
  readonly totalPages: number;
}
