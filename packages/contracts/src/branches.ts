import type { PageQuery } from "./common.js";

/**
 * Branch = filial/unidade de uma Company. Sem exclusão: desativação por status.
 *
 * GET   /branches                        `branch.read`   query ListBranchesQuery -> 200 Page<BranchDto>
 * GET   /branches/:branchId              `branch.read`   -> 200 BranchDto | 404 not_found
 * POST  /branches                        `branch.manage` CreateBranchRequest -> 201 BranchDto
 *                                         404 not_found (companyId) | 409 company_inactive
 *                                         409 branch_code_already_exists | 409 branch_cnpj_already_exists
 * PATCH /branches/:branchId              `branch.manage` UpdateBranchRequest -> 200 BranchDto | 404 | 409 (code/cnpj)
 * POST  /branches/:branchId/deactivate   `branch.manage` -> 200 BranchDto | 404
 * POST  /branches/:branchId/activate     `branch.manage` -> 200 BranchDto | 404 | 409 company_inactive
 *
 * GET   /me/branches                     só autenticação -> 200 BranchSummaryDto[]
 *        Filiais em que o usuário logado pode operar: com UserBranchAccess, filial ACTIVE e empresa ACTIVE.
 *        Use para o seletor de filial do PDV. Não paginado.
 *
 * `branch.read`/`branch.manage` são avaliadas no escopo do tenant (cadastro). Operações DENTRO de uma filial (pedidos,
 * caixa...) exigem também acesso à filial (UserBranchAccess), em módulos futuros.
 */

export const BRANCH_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export interface BranchDto {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  /** Código operacional normalizado: maiúsculo, `[A-Z0-9_-]`, 1–32, começa por letra ou dígito (ex.: `MORUMBI`). */
  readonly code: string;
  /** Mesmo formato de `CompanyDto.cnpj`; `null` = filial sem CNPJ próprio. */
  readonly cnpj: string | null;
  readonly status: BranchStatus;
  /** Identificador IANA. */
  readonly timezone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Versão curta para seletores e para o acesso de usuários. */
export interface BranchSummaryDto {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly code: string;
  readonly status: BranchStatus;
}

export interface CreateBranchRequest {
  /** Company do tenant; precisa estar ACTIVE. Imutável depois de criada. */
  readonly companyId: string;
  /** 1–120 caracteres após trim. */
  readonly name: string;
  /** Trim + maiúsculo antes de validar (` morumbi ` -> `MORUMBI`). Único por tenant (não por company). */
  readonly code: string;
  /**
   * Opcional; `null`/ausente = sem CNPJ. Mesmas regras do CNPJ da Company e, além disso, a RAIZ (8 primeiros caracteres)
   * deve ser igual à da Company (`cnpj_root_mismatch`). Único por tenant.
   */
  readonly cnpj?: string | null;
  /** Identificador IANA; ausente = mesmo timezone da Company. */
  readonly timezone?: string;
}

/** Todos opcionais. `companyId` e `status` não são alteráveis por aqui; `cnpj: null` remove o CNPJ. */
export interface UpdateBranchRequest {
  readonly name?: string;
  readonly code?: string;
  readonly cnpj?: string | null;
  readonly timezone?: string;
}

export interface ListBranchesQuery extends PageQuery {
  readonly companyId?: string;
  readonly status?: BranchStatus;
}

export const BRANCH_NAME_MAX_LENGTH = 120;
export const BRANCH_CODE_MAX_LENGTH = 32;
/** Depois do trim + maiúsculo. */
export const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
