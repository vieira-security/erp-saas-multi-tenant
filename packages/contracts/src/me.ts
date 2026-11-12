import type { BranchStatus } from "./branches.js";
import type { TenantStatus } from "./organization.js";

/**
 * Quem sou eu (KAN-52) — usado pelo frontend para montar a interface (menu, botões, seletor de filial). A API continua
 * sendo a autoridade: cada rota confere a permissão de novo (403). Permissões NÃO vão no JWT.
 *
 * GET /me   só autenticação -> 200 MeDto
 *           (com troca de senha obrigatória a resposta é 403 `password_change_required`, como nas rotas de negócio)
 * GET /me/branches  (M3, continua existindo) -> só as filiais OPERÁVEIS, versão curta para o seletor do PDV.
 *
 * Permissões efetivas = permissões das roles ACTIVE do usuário. No escopo do TENANT contam só as roles sem filial; NUMA
 * FILIAL contam as roles sem filial + as roles atribuídas àquela filial, e só se o usuário tiver acesso a ela
 * (UserBranchAccess). Ex.: um ATTENDANT tenant-wide sem acesso à filial X não tem permissão nenhuma em X.
 * Use `permissions` para telas de cadastro (empresas, filiais, produtos, usuários) e `branches[].permissions` para tudo
 * que fica em `/branches/:branchId/...` (pedidos, caixa, cardápio, ajustes por filial).
 */

/** Catálogo atual de permissões (seed da API). Uma permissão nova exige decisão de produto e atualização aqui. */
export const PERMISSION_CODES = [
  "organization.read",
  "organization.manage",
  "branch.read",
  "branch.manage",
  "user.read",
  "user.manage",
  "role.read",
  "role.manage",
  "product.read",
  "product.manage",
  "order.read",
  "order.create",
  "order.cancel",
  "order.prepare",
  "cash.read",
  "cash.open",
  "cash.close",
  "fiscal.read",
  "fiscal.issue",
  "fiscal.cancel",
  "audit.read",
  "audit.read_tenant",
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export interface MeUserDto {
  readonly id: string;
  readonly name: string;
  readonly employeeNumber: string;
  readonly mustChangePassword: boolean;
}

export interface MeOrganizationDto {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly loginCode: string | null;
}

export interface MeBranchDto {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly code: string;
  readonly status: BranchStatus;
  /** Filial ACTIVE de empresa ACTIVE: dá para abrir pedido/caixa nela (mesmo critério de `/me/branches`). */
  readonly operable: boolean;
  /** Permissões efetivas NESTA filial, em ordem alfabética. */
  readonly permissions: readonly PermissionCode[];
}

export interface MeDto {
  readonly user: MeUserDto;
  readonly organization: MeOrganizationDto;
  /** Permissões efetivas no escopo do tenant (roles sem filial), em ordem alfabética. */
  readonly permissions: readonly PermissionCode[];
  /** TODAS as filiais com acesso (inclusive inativas, para telas administrativas), ordem de criação. */
  readonly branches: readonly MeBranchDto[];
}

/**
 * Preferências do próprio usuário (KAN-42). Só o próprio usuário lê e grava as suas (sem permissão específica, só
 * autenticação). Com troca de senha obrigatória segue o guard: 403 `password_change_required`.
 *
 * GET /me/preferences   -> 200 MePreferencesDto (usuário que nunca gravou recebe os defaults)
 * PUT /me/preferences   UpdateMePreferencesRequest -> 200 MePreferencesDto
 *                       400 validation_failed (valor fora da lista, campo desconhecido, corpo vazio = `required`)
 */
export const CATALOG_VIEWS = ["GRID", "LIST"] as const;
export type CatalogView = (typeof CATALOG_VIEWS)[number];

export interface MePreferencesDto {
  /** Modo do cardápio no PDV. Default `GRID` (botões grandes para toque). */
  readonly catalogView: CatalogView;
}

/** Substitui as preferências enviadas (hoje só `catalogView`, obrigatório). */
export interface UpdateMePreferencesRequest {
  readonly catalogView: CatalogView;
}
