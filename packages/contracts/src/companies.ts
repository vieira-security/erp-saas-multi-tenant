import type { PageQuery } from "./common.js";

/**
 * Company = pessoa jurídica (CNPJ) do tenant. Sem exclusão: desativação por status.
 *
 * GET   /companies                        `organization.read`   query ListCompaniesQuery -> 200 Page<CompanyDto>
 * GET   /companies/:companyId             `organization.read`   -> 200 CompanyDto | 404 not_found
 * POST  /companies                        `organization.manage` CreateCompanyRequest -> 201 CompanyDto
 *                                          409 company_cnpj_already_exists
 * PATCH /companies/:companyId             `organization.manage` UpdateCompanyRequest -> 200 CompanyDto | 404
 * POST  /companies/:companyId/deactivate  `organization.manage` -> 200 CompanyDto | 404
 *                                          409 company_has_active_branches (desative as filiais antes)
 * POST  /companies/:companyId/activate    `organization.manage` -> 200 CompanyDto | 404
 *
 * Ativar/desativar é idempotente (já no status pedido = 200 sem mudança).
 */

export const COMPANY_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export interface CompanyDto {
  readonly id: string;
  readonly legalName: string;
  readonly tradeName: string;
  /**
   * 14 caracteres, sem máscara, maiúsculo. Numérico (`11222333000181`) ou alfanumérico (Receita Federal, desde
   * 07/2026: 12 primeiros caracteres `[0-9A-Z]`, 2 dígitos verificadores numéricos).
   */
  readonly cnpj: string;
  readonly status: CompanyStatus;
  /** Identificador IANA (ex.: `America/Sao_Paulo`). */
  readonly timezone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCompanyRequest {
  /** Razão social, 1–200 caracteres após trim. */
  readonly legalName: string;
  /** Nome fantasia, 1–200 caracteres após trim. */
  readonly tradeName: string;
  /**
   * Aceita com ou sem máscara (`11.222.333/0001-81`), minúsculas viram maiúsculas. Dígitos verificadores são validados
   * (`invalid_cnpj`). Único por tenant. Imutável depois de criado.
   */
  readonly cnpj: string;
  /** Identificador IANA. Offsets fixos (`-03:00`, `GMT-3`) são rejeitados (`invalid_timezone`). */
  readonly timezone: string;
}

/** Todos opcionais; corpo vazio = 200 sem mudança. `cnpj` e `status` não são alteráveis por aqui. */
export interface UpdateCompanyRequest {
  readonly legalName?: string;
  readonly tradeName?: string;
  readonly timezone?: string;
}

export interface ListCompaniesQuery extends PageQuery {
  readonly status?: CompanyStatus;
}

export const COMPANY_NAME_MAX_LENGTH = 200;
