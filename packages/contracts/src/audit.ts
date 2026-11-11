import type { PageQuery } from "./common.js";

/**
 * Histórico de auditoria (KAN-41). Decisões de produto (10/11/2026):
 * - ESCOPO: além dos eventos de segurança (auth.*) e de funcionários (user.*), que já existem, registra dinheiro
 *   (caixa, sangria, suprimento, cancelamento com estorno), cardápio (produto, categoria, ajuste por filial),
 *   organização (empresa, filial, acesso a filial), setores de cozinha e REIMPRESSÃO de comanda (via ≥ 2).
 *   Não registra rascunho de pedido, confirmação/pagamento normal nem start/ready (já ficam no próprio pedido/comanda).
 * - QUEM VÊ: `audit.read` (Dono e Gerente) vê eventos COM filial nas filiais onde tem `audit.read` (exige acesso à
 *   filial). Eventos SEM filial (tenant: funcionários, cardápio do tenant, empresa, segurança) exigem também
 *   `audit.read_tenant` (só o Dono pela matriz). Filtro por filial sem acesso -> 403.
 * - DETALHE: alterações guardam ANTES e DEPOIS só dos campos que mudaram (`metadata.changes`). Nunca senha, hash,
 *   token, segredo ou dado de cartão.
 * - Append-only: não existe rota de alteração ou exclusão.
 *
 * `audit.read` e `audit.read_tenant` entram em `PERMISSION_CODES` (me.ts) junto com o catálogo e a matriz, no PR de
 * implementação (teste fail-closed contrato × catálogo).
 *
 * GET /audit-logs   `audit.read` (ver regra acima)   query ListAuditLogsQuery -> 200 Page<AuditLogDto>
 *                   Ordem: MAIS RECENTE primeiro (`createdAt` desc, `id` desc) — exceção à ordem por criação.
 *                   400 validation_failed (datas inválidas, `from` > `to`, ação fora do catálogo, campo desconhecido)
 *                   403 forbidden (sem permissão, ou `branchId` sem acesso)
 */

/** Catálogo de ações (estável; o front traduz pelo código). */
export const AUDIT_ACTIONS = [
  // Segurança (já existentes)
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.password.change_failed",
  "auth.lockout.triggered",
  "auth.session.revoked",
  "auth.sessions.revoked",
  "auth.refresh.replay_detected",
  "auth.password.changed",
  "auth.password.reset",
  // Funcionários (já existentes)
  "user.created",
  "user.updated",
  "user.roles_replaced",
  "user.deactivated",
  "user.activated",
  "user.unlocked",
  // Organização
  "organization.updated",
  "company.created",
  "company.updated",
  "company.activated",
  "company.deactivated",
  "branch.created",
  "branch.updated",
  "branch.activated",
  "branch.deactivated",
  "branch_access.granted",
  "branch_access.revoked",
  // Cardápio
  "product_category.created",
  "product_category.updated",
  "product_category.activated",
  "product_category.deactivated",
  "product.created",
  "product.updated",
  "product.option_groups_replaced",
  "product.activated",
  "product.deactivated",
  "branch_product_setting.updated",
  // Caixa e dinheiro
  "cash_session.opened",
  "cash_session.closed",
  "cash_movement.withdrawal",
  "cash_movement.supply",
  "order.cancelled",
  // Cozinha
  "kitchen_sector.created",
  "kitchen_sector.updated",
  "kitchen_sector.activated",
  "kitchen_sector.deactivated",
  "kitchen_sector.default_changed",
  "branch_kitchen_sector.updated",
  "kitchen_ticket.reprinted",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface ListAuditLogsQuery extends PageQuery {
  /** ISO 8601, inclusivo. */
  readonly from?: string;
  /** ISO 8601, exclusivo. */
  readonly to?: string;
  /** Uma ou mais ações do catálogo separadas por vírgula. */
  readonly action?: string;
  /** Quem fez (ator). */
  readonly userId?: string;
  /** Só eventos desta filial (precisa de `audit.read` nela). */
  readonly branchId?: string;
  /** Ex.: `product`, `cash_session`, `order`. */
  readonly resourceType?: string;
  /** Histórico de um recurso (use junto com `resourceType`). */
  readonly resourceId?: string;
}

export interface AuditActorDto {
  readonly userId: string;
  /** Nome atual do usuário. */
  readonly name: string;
}

export interface AuditBranchDto {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

/** Valor antes/depois de um campo alterado (dinheiro como string `"25.00"`, datas ISO). */
export interface AuditFieldChange {
  readonly from: unknown;
  readonly to: unknown;
}

export interface AuditLogDto {
  readonly id: string;
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId: string | null;
  /** `null` = evento do tenant (sem filial). */
  readonly branch: AuditBranchDto | null;
  /** Quem fez; `null` = sistema ou tentativa sem usuário identificado (ex.: login falho). */
  readonly actor: AuditActorDto | null;
  /**
   * Detalhes por ação, sem segredos. Alterações: `{ changes: { campo: { from, to } } }` só com os campos que mudaram.
   * Ex.: `product.updated` -> `{ changes: { basePrice: { from: "25.00", to: "27.00" } } }`;
   * `cash_session.closed` -> `{ expectedCash, countedCash, difference, justification }`;
   * `order.cancelled` -> `{ number, previousStatus, reason, refunds: [{ method, amount }] }`.
   */
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
}
