import type { PageQuery } from "./common.js";
import type { PaymentDto, PaymentInput, RefundDto } from "./cash.js";
import type { Money } from "./products.js";

/**
 * M5 — Pedidos do PDV (balcão).
 *
 * Decisões de produto (09/11/2026):
 * - Só atendimento de BALCÃO COM SENHA: o cliente pede no caixa, recebe um número e retira quando chamado. Sem mesa,
 *   comanda aberta, delivery ou cadastro de cliente no M5.
 * - Número do pedido POR FILIAL, reiniciando todo dia (#1, #2...), no fuso da filial. Atribuído só na CONFIRMAÇÃO:
 *   rascunho descartado não consome número.
 * - Cancelamento: rascunho (EDITING) pode ser descartado por quem o criou; pedido confirmado só por quem tem
 *   `order.cancel` na filial (OWNER/MANAGER), com motivo obrigatório. **M6:** pedido DELIVERED também pode ser
 *   cancelado (com estorno total) por quem tem `order.cancel`.
 * - Sem descontos no M5: preço = preço do produto na filial + soma dos `priceDelta` das opções escolhidas.
 * - Filial ou empresa INACTIVE não abre nem confirma pedido (409 `branch_inactive`/`company_inactive`).
 * - **M6 (09/11/2026): o pedido é PAGO ANTES DE CONFIRMAR.** A confirmação recebe os pagamentos (`ConfirmOrderRequest`) e
 *   só acontece se a soma bater com o total recalculado; os pagamentos caem no caixa aberto de quem confirma. Cancelar
 *   pedido pago gera estorno total de todos os pagamentos (ver cash.ts).
 *
 * Estados:   EDITING ──confirm──▶ CONFIRMED ──start──▶ PREPARING ──ready──▶ READY ──deliver──▶ DELIVERED
 *               │                     │                    │                   │
 *               └──────────── cancel ─┴────────────────────┴───────────────────┴─────────────┴──▶ CANCELLED
 *                                                                                    (M6: DELIVERED também cancela)
 * Transição fora dessa ordem -> 409 `order_invalid_transition` (repetir a transição já feita também é 409).
 *
 * Itens são CÓPIAS (snapshot) do cardápio: nome, código, preços e opções ficam gravados no pedido. Alterar ou desativar o
 * produto depois não muda pedidos existentes. Os preços são recalculados na confirmação a partir do cardápio vigente da
 * filial; se algum item deixou de ser vendável, a confirmação falha com 409 `order_item_unavailable` + `details`.
 *
 * Todas as rotas são de FILIAL (exigem UserBranchAccess; filial sem acesso, de outro tenant ou inexistente -> 403).
 * Pedido de outra filial ou de outro tenant -> 404.
 *
 * POST /branches/:branchId/orders                          `order.create` CreateOrderRequest -> 201 OrderDto (EDITING)
 *                                                          409 branch_inactive | company_inactive
 * GET  /branches/:branchId/orders                          `order.read`   query ListOrdersQuery -> 200 Page<OrderSummaryDto>
 * GET  /branches/:branchId/orders/:orderId                 `order.read`   -> 200 OrderDto | 404
 * PUT  /branches/:branchId/orders/:orderId/items           `order.create` ReplaceOrderItemsRequest -> 200 OrderDto
 *                                                          Substitui TODOS os itens; só em EDITING (409 order_not_editable)
 * POST /branches/:branchId/orders/:orderId/confirm         `order.create` ConfirmOrderRequest -> 200 OrderDto (CONFIRMED,
 *                                                          com `number` e `payments`)
 *                                                          409 order_empty | order_item_unavailable | branch_inactive |
 *                                                              company_inactive | order_invalid_transition |
 *                                                              cash_session_required (M6) | payment_total_mismatch (M6)
 * POST /branches/:branchId/orders/:orderId/start           `order.create` -> 200 OrderDto (PREPARING)
 * POST /branches/:branchId/orders/:orderId/ready           `order.create` -> 200 OrderDto (READY)
 * POST /branches/:branchId/orders/:orderId/deliver         `order.create` -> 200 OrderDto (DELIVERED)
 * POST /branches/:branchId/orders/:orderId/cancel          CancelOrderRequest -> 200 OrderDto (CANCELLED)
 *        EDITING: quem criou (com `order.create`) OU quem tem `order.cancel`; motivo opcional.
 *        CONFIRMED/PREPARING/READY/DELIVERED (M6): `order.cancel` na filial; `reason` obrigatório
 *        (`validation_failed`/`required`); estorna todos os pagamentos. Estorno em dinheiro exige caixa aberto de quem
 *        cancela (409 `cash_session_required`) com dinheiro esperado suficiente (409 `insufficient_cash`; ex.: fazer
 *        suprimento antes). Sem permissão para o caso -> 403. CANCELLED -> 409 order_invalid_transition.
 *
 * As transições start/ready/deliver usam `order.create` no M5 (a role KITCHEN só tem `order.read`). Permissão própria
 * da cozinha é decisão do M7 (Kitchen Display).
 */

export const ORDER_STATUSES = ["EDITING", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Pessoa que executou uma ação no pedido. */
export interface OrderActorDto {
  readonly userId: string;
  readonly name: string;
}

export interface OrderItemOptionDto {
  readonly optionId: string;
  /** Cópia do nome do grupo no momento do pedido (ex.: "Tamanho"). */
  readonly groupName: string;
  /** Cópia do nome da opção (ex.: "Grande"). */
  readonly name: string;
  readonly priceDelta: Money;
  /** Produto vinculado (combo), se houver. */
  readonly linkedProductId: string | null;
}

export interface OrderItemDto {
  readonly id: string;
  readonly productId: string;
  /** Cópias do cardápio no momento do pedido. */
  readonly productName: string;
  readonly productCode: string | null;
  readonly quantity: number;
  /** Preço do produto na filial + soma dos `priceDelta` das opções, por unidade. */
  readonly unitPrice: Money;
  /** `unitPrice × quantity`. */
  readonly lineTotal: Money;
  readonly options: readonly OrderItemOptionDto[];
  /** Observação livre (ex.: "sem cebola"); `null` = sem observação. */
  readonly note: string | null;
}

/** Linha de listagem (sem itens). */
export interface OrderSummaryDto {
  readonly id: string;
  readonly branchId: string;
  /** Número do dia na filial; `null` enquanto EDITING (ou rascunho cancelado). */
  readonly number: number | null;
  /** Dia de operação (`YYYY-MM-DD`, fuso da filial) em que o número foi atribuído; `null` antes da confirmação. */
  readonly businessDate: string | null;
  readonly status: OrderStatus;
  readonly itemCount: number;
  readonly total: Money;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

export interface OrderDto extends OrderSummaryDto {
  readonly items: readonly OrderItemDto[];
  readonly createdBy: OrderActorDto;
  readonly preparingAt: string | null;
  readonly readyAt: string | null;
  readonly deliveredAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledBy: OrderActorDto | null;
  readonly cancelReason: string | null;
  /** M6: pagamentos registrados na confirmação (vazio em EDITING). */
  readonly payments: readonly PaymentDto[];
  /** M6: estornos (um por pagamento) quando o pedido pago foi cancelado. */
  readonly refunds: readonly RefundDto[];
  /** M6: soma do troco dado em dinheiro. */
  readonly changeGiven: Money;
}

/**
 * M6: pagamento na confirmação. Lista vazia só quando o total é `"0.00"`. Soma dos `amount` ≠ total recalculado ->
 * 409 `payment_total_mismatch`: o pedido continua EDITING, SEM número e SEM pagamento gravado, mas os itens e o total do
 * rascunho JÁ SÃO ATUALIZADOS com os preços vigentes (é o único erro da confirmação que deixa efeito). Releia o pedido
 * (GET) e reenvie os pagamentos com o total novo. Formato inválido ->
 * 400 com caminho (`payments[1].receivedAmount`).
 */
export interface ConfirmOrderRequest {
  /** 0–10 pagamentos (split). */
  readonly payments: readonly PaymentInput[];
}

export interface OrderItemInput {
  readonly productId: string;
  /** 1–99. */
  readonly quantity: number;
  /**
   * Opções escolhidas (ids de ProductOption do produto), sem repetição. Por grupo: entre `minChoices` e `maxChoices`
   * do cardápio da filial. Default `[]`.
   */
  readonly optionIds?: readonly string[];
  /** Até 140 caracteres após trim; vazio = sem observação. */
  readonly note?: string | null;
}

/** Corpo opcional: pode criar o rascunho vazio e enviar os itens depois. */
export interface CreateOrderRequest {
  readonly items?: readonly OrderItemInput[];
}

export interface ReplaceOrderItemsRequest {
  /** 0–100 itens (lista vazia permitida em EDITING; a confirmação exige ao menos 1). */
  readonly items: readonly OrderItemInput[];
}

export interface CancelOrderRequest {
  /** 3–200 caracteres após trim. Obrigatório para pedido já confirmado. */
  readonly reason?: string;
}

export interface ListOrdersQuery extends PageQuery {
  /** Um ou mais estados separados por vírgula: `CONFIRMED,PREPARING`. */
  readonly status?: string;
  /** `YYYY-MM-DD` (fuso da filial): só pedidos confirmados nesse dia. */
  readonly businessDate?: string;
}

/**
 * Validação dos itens (PUT items / POST orders) -> 400 `validation_failed` com `field` no caminho do item:
 * - `items[0].productId`  `unavailable`      produto inexistente, de outro tenant, INACTIVE ou indisponível na filial;
 * - `items[0].optionIds`  `invalid_choices`  opção que não é do produto, opção vinculada indisponível, repetida ou
 *                                            quantidade fora de min/max de algum grupo;
 * - `items[0].quantity`   `invalid_value`    fora de 1–99.
 * Na confirmação, o mesmo problema vira 409 `order_item_unavailable` com os mesmos `details`.
 * Listagem: mais recentes primeiro (`createdAt` decrescente, `id` para desempate) — exceção à ordem padrão.
 */
export const ORDER_ITEMS_MAX = 100;
export const ORDER_ITEM_QUANTITY_MAX = 99;
export const ORDER_ITEM_NOTE_MAX_LENGTH = 140;
export const CANCEL_REASON_MIN_LENGTH = 3;
export const CANCEL_REASON_MAX_LENGTH = 200;
