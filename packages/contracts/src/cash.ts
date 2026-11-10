import type { PageQuery } from "./common.js";
import type { Money } from "./products.js";

/**
 * M6 — Caixa e pagamentos.
 *
 * Decisões de produto (09/11/2026):
 * - PIX e cartão são REGISTRO MANUAL: o cliente paga na maquininha ou no PIX da loja e o operador registra forma e valor.
 *   Integração com PSP/TEF fica para depois. Dinheiro calcula troco.
 * - O pedido de balcão é PAGO ANTES DE CONFIRMAR: a confirmação recebe os pagamentos (ver orders.ts, `ConfirmOrderRequest`).
 *   Vários pagamentos por pedido (split) são permitidos.
 * - UM CAIXA POR OPERADOR NA FILIAL: cada operador abre e fecha o próprio caixa; os pagamentos recebidos (e o troco) caem
 *   no caixa ABERTO de quem confirmou. Sem caixa aberto não confirma pedido (409 `cash_session_required`).
 * - O operador fecha o PRÓPRIO caixa (basta `cash.open`); quem tem `cash.close` (OWNER/MANAGER) fecha o de qualquer um.
 * - Fechamento com o valor esperado VISÍVEL. Qualquer diferença (contado ≠ esperado) exige justificativa.
 * - Sangria (retirada) e suprimento (reforço de troco): só `cash.close` (OWNER/MANAGER), com motivo.
 * - Cancelar pedido pago gera ESTORNO TOTAL; só quem tem `order.cancel`, com motivo; vale também para pedido entregue.
 *   Estorno em dinheiro sai do caixa aberto de quem cancelou (sem caixa aberto -> 409 `cash_session_required`; sem dinheiro
 *   esperado suficiente nesse caixa -> 409 `insufficient_cash`, como na sangria); estorno de
 *   PIX/cartão é registrado como "a devolver na maquininha" e não mexe no dinheiro do caixa.
 *
 * Valor esperado em DINHEIRO de um caixa =
 *   abertura + suprimentos − sangrias + recebido em dinheiro − troco dado − estornos em dinheiro.
 * PIX e cartões aparecem no resumo para conferência, sem contagem.
 *
 * Rotas de FILIAL (exigem UserBranchAccess; sem acesso/filial de outro tenant -> 403). Caixa de outra filial/tenant -> 404.
 *
 * POST /branches/:branchId/cash-sessions                       `cash.open` OpenCashSessionRequest -> 201 CashSessionDto
 *                                                              409 cash_session_already_open | branch_inactive | company_inactive
 * GET  /branches/:branchId/cash-sessions/current               `cash.open` -> 200 CashSessionDto (caixa aberto do usuário) | 404
 * GET  /branches/:branchId/cash-sessions                       `cash.read` query ListCashSessionsQuery -> 200 Page<CashSessionSummaryDto>
 *        Sem `cash.close` na filial: só os caixas do próprio usuário. Mais recentes primeiro.
 * GET  /branches/:branchId/cash-sessions/:sessionId            `cash.read` -> 200 CashSessionDto | 404 (de outro operador sem `cash.close` = 404)
 * POST /branches/:branchId/cash-sessions/:sessionId/movements  `cash.close` CashMovementRequest -> 201 CashSessionDto
 *                                                              409 cash_session_closed | insufficient_cash (sangria > dinheiro esperado)
 * POST /branches/:branchId/cash-sessions/:sessionId/close      CloseCashSessionRequest -> 200 CashSessionDto (CLOSED)
 *        Próprio caixa: `cash.open`. Caixa de outro operador: `cash.close`. Senão 403. Já fechado -> 409 cash_session_closed.
 *        Diferença ≠ 0 sem `justification` -> 400 validation_failed (`justification`/`required`).
 */

export const PAYMENT_METHODS = ["CASH", "PIX", "DEBIT_CARD", "CREDIT_CARD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CASH_SESSION_STATUSES = ["OPEN", "CLOSED"] as const;
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number];

export const CASH_MOVEMENT_TYPES = ["SUPPLY", "WITHDRAWAL"] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export interface CashActorDto {
  readonly userId: string;
  readonly name: string;
}

/** Pagamento registrado na confirmação do pedido. */
export interface PaymentDto {
  readonly id: string;
  readonly method: PaymentMethod;
  /** Parte do total do pedido paga por este pagamento (> 0). */
  readonly amount: Money;
  /** Só CASH: valor entregue pelo cliente (≥ `amount`); `null` nos demais. */
  readonly receivedAmount: Money | null;
  /** Só CASH: `receivedAmount − amount`; `"0.00"` nos demais. */
  readonly change: Money;
  /** NSU/autorização/identificador do PIX, se informado. */
  readonly reference: string | null;
  readonly cashSessionId: string;
  readonly createdAt: string;
}

/** Estorno de um pagamento (cancelamento de pedido pago). Um por pagamento; sempre do valor total do pagamento. */
export interface RefundDto {
  readonly id: string;
  readonly paymentId: string;
  readonly method: PaymentMethod;
  readonly amount: Money;
  /** CASH: caixa de quem estornou (o dinheiro saiu dele). PIX/cartão: `null` (devolução manual na maquininha). */
  readonly cashSessionId: string | null;
  readonly createdAt: string;
}

export interface PaymentInput {
  readonly method: PaymentMethod;
  /** > 0. A soma dos `amount` de todos os pagamentos tem que ser IGUAL ao total recalculado do pedido. */
  readonly amount: Money;
  /** Obrigatório e ≥ `amount` em CASH (troco = diferença). Proibido nos demais métodos. */
  readonly receivedAmount?: Money;
  /** Opcional, 1–60 caracteres (NSU, autorização, id do PIX). */
  readonly reference?: string | null;
}

export interface CashMethodTotalDto {
  readonly method: PaymentMethod;
  /** Recebido menos estornado nesse método, neste caixa. Em CASH já desconta o troco. */
  readonly net: Money;
}

export interface CashSessionSummaryDto {
  readonly id: string;
  readonly branchId: string;
  readonly status: CashSessionStatus;
  readonly openedBy: CashActorDto;
  readonly openedAt: string;
  readonly openingAmount: Money;
  readonly closedAt: string | null;
  /** Diferença do fechamento (contado − esperado em dinheiro); `null` enquanto aberto. */
  readonly difference: Money | null;
}

export interface CashMovementDto {
  readonly id: string;
  readonly type: CashMovementType;
  readonly amount: Money;
  readonly reason: string;
  readonly createdBy: CashActorDto;
  readonly createdAt: string;
}

export interface CashSessionDto extends CashSessionSummaryDto {
  /** Dinheiro que deveria estar na gaveta agora (aberto) ou no fechamento (fechado). */
  readonly expectedCash: Money;
  /** Totais líquidos por método neste caixa. */
  readonly totals: readonly CashMethodTotalDto[];
  readonly movements: readonly CashMovementDto[];
  readonly closedBy: CashActorDto | null;
  /** Dinheiro contado no fechamento. */
  readonly countedCash: Money | null;
  readonly justification: string | null;
}

export interface OpenCashSessionRequest {
  /** Fundo de troco inicial (≥ 0). */
  readonly openingAmount: Money;
}

export interface CashMovementRequest {
  readonly type: CashMovementType;
  /** > 0. */
  readonly amount: Money;
  /** 3–200 caracteres após trim. */
  readonly reason: string;
}

export interface CloseCashSessionRequest {
  /** Dinheiro contado na gaveta (≥ 0). */
  readonly countedCash: Money;
  /** 3–500 caracteres; obrigatória quando contado ≠ esperado. */
  readonly justification?: string | null;
}

export interface ListCashSessionsQuery extends PageQuery {
  readonly status?: CashSessionStatus;
}

/** Diferença negativa (`"-5.00"`) só aparece em `difference`; todos os outros `Money` são ≥ 0. */
export const PAYMENT_REFERENCE_MAX_LENGTH = 60;
export const CASH_MOVEMENT_REASON_MIN_LENGTH = 3;
export const CASH_MOVEMENT_REASON_MAX_LENGTH = 200;
export const CASH_JUSTIFICATION_MIN_LENGTH = 3;
export const CASH_JUSTIFICATION_MAX_LENGTH = 500;
/** Pagamentos por pedido. */
export const PAYMENTS_PER_ORDER_MAX = 10;
