import type { PageQuery } from "./common.js";

/**
 * M7 — Cozinha: setores de preparo, comandas por setor e impressão pelo navegador.
 *
 * Decisões de produto (10/11/2026):
 * - Permissão nova `order.prepare` (iniciar/terminar preparo): Proprietário, Gerente, Atendente e Cozinha. Entregar
 *   (`deliver`) continua com `order.create`.
 *   `order.prepare` entra em `PERMISSION_CODES` (me.ts) junto com o catálogo, a matriz e o backfill dos tenants, no PR de
 *   implementação (o teste que compara contrato × catálogo é fail-closed).
 * - SETORES são do TENANT (ex.: Cozinha, Bar). Cada produto aponta para um setor (`kitchenSectorId`; `null` = setor
 *   padrão). Cada FILIAL só liga/desliga setores. Item cujo setor está INACTIVE no tenant ou desligado na filial vai para
 *   o setor padrão. Existe sempre exatamente UM setor padrão por tenant (criado no provisionamento como "Cozinha"), que
 *   não pode ser desativado nem desligado em filial.
 * - Na CONFIRMAÇÃO do pedido (mesma transação) nasce UMA COMANDA POR SETOR, só com os itens daquele setor. Combo vai
 *   INTEIRO no setor do produto principal (opções e itens vinculados não mudam de setor).
 * - Status por comanda: WAITING → PREPARING → READY. O status do pedido passa a ser DERIVADO das comandas:
 *   todas WAITING = CONFIRMED; alguma PREPARING (ou parte READY) = PREPARING; todas READY = READY.
 * - `POST /orders/:id/start` e `/ready` (M5) viram ATALHO: agem em todas as comandas abertas do pedido
 *   (start: WAITING → PREPARING; ready: WAITING/PREPARING → READY). Pedido sem comandas (confirmado antes do M7) mantém
 *   o comportamento do M5.
 * - Pedido cancelado: todas as comandas viram CANCELLED (nada é apagado). A tela da cozinha destaca e o front pode
 *   imprimir o aviso de cancelamento (`print` de comanda CANCELLED).
 * - Impressão pelo NAVEGADOR (térmica 80 mm instalada no sistema). A API devolve o texto pronto (`lines`, 48 colunas)
 *   e conta as vias; agente local ESC/POS fica para depois (reaproveita `lines`).
 *
 * Setores (tenant):
 * GET   /kitchen-sectors                          `product.read`   -> 200 KitchenSectorDto[] (padrão primeiro, depois
 *                                                                     `sortOrder`, `name` por código)
 * POST  /kitchen-sectors                          `product.manage` CreateKitchenSectorRequest -> 201 KitchenSectorDto
 *                                                  409 kitchen_sector_code_already_exists
 * PATCH /kitchen-sectors/:sectorId                `product.manage` UpdateKitchenSectorRequest -> 200 | 404 | 409 (código)
 * POST  /kitchen-sectors/:sectorId/make-default   `product.manage` -> 200 KitchenSectorDto | 404
 *                                                  409 kitchen_sector_inactive (setor INACTIVE não vira padrão)
 * POST  /kitchen-sectors/:sectorId/activate       `product.manage` -> 200 | 404
 * POST  /kitchen-sectors/:sectorId/deactivate     `product.manage` -> 200 | 404 | 409 kitchen_sector_default_required
 *   (ativar/desativar/tornar padrão são idempotentes)
 *
 * Setores na filial:
 * GET /branches/:branchId/kitchen-sectors              `product.read` NA FILIAL -> 200 BranchKitchenSectorDto[]
 * PUT /branches/:branchId/kitchen-sectors/:sectorId    `product.manage` NA FILIAL UpdateBranchKitchenSectorRequest
 *                                                      -> 200 BranchKitchenSectorDto | 404
 *                                                      409 kitchen_sector_default_required (desligar o padrão)
 *
 * Comandas (filial; mesmas regras de acesso dos pedidos: sem acesso -> 403, de outra filial/tenant -> 404):
 * GET  /branches/:branchId/kitchen-tickets                  `order.read`    query ListKitchenTicketsQuery
 *                                                           -> 200 Page<KitchenTicketDto> (ordem de chegada:
 *                                                              `createdAt`, depois `id`)
 * GET  /branches/:branchId/kitchen-tickets/:ticketId        `order.read`    -> 200 KitchenTicketDto | 404
 * POST /branches/:branchId/kitchen-tickets/:ticketId/start  `order.prepare` -> 200 KitchenTicketDto (PREPARING)
 * POST /branches/:branchId/kitchen-tickets/:ticketId/ready  `order.prepare` -> 200 KitchenTicketDto (READY)
 *        transição fora da ordem (inclusive repetir, ou comanda CANCELLED) -> 409 kitchen_ticket_invalid_transition
 * POST /branches/:branchId/kitchen-tickets/:ticketId/print  `order.read`    -> 200 KitchenTicketPrintDto
 *        Toda chamada conta uma via (`copyNumber` 1 = original; a partir da 2ª, cabeçalho com o número da via: "2ª VIA", "3ª VIA"…); comanda CANCELLED imprime o aviso.
 */

export const KITCHEN_SECTOR_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type KitchenSectorStatus = (typeof KITCHEN_SECTOR_STATUSES)[number];

export interface KitchenSectorDto {
  readonly id: string;
  readonly name: string;
  /** Trim + maiúsculo, `^[A-Z0-9][A-Z0-9_-]{0,31}$`; único no tenant. */
  readonly code: string;
  readonly isDefault: boolean;
  readonly status: KitchenSectorStatus;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateKitchenSectorRequest {
  /** 1–60 caracteres após trim. */
  readonly name: string;
  readonly code: string;
  /** 0–9999; default 0. */
  readonly sortOrder?: number;
}

/** Campos opcionais; corpo vazio = 200 sem mudança (padrão das PATCH do repo). `status` e padrão só pelas ações próprias. */
export interface UpdateKitchenSectorRequest {
  readonly name?: string;
  readonly code?: string;
  readonly sortOrder?: number;
}

export interface BranchKitchenSectorDto {
  readonly sector: KitchenSectorDto;
  /** Ligado nesta filial. Padrão: sempre `true`. Sem ajuste gravado = ligado. */
  readonly enabled: boolean;
  /** `true` se recebe comandas aqui: ligado na filial E ACTIVE no tenant (o padrão sempre recebe). */
  readonly receivesTickets: boolean;
}

export interface UpdateBranchKitchenSectorRequest {
  readonly enabled: boolean;
}

export const KITCHEN_TICKET_STATUSES = ["WAITING", "PREPARING", "READY", "CANCELLED"] as const;
export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];

export interface ListKitchenTicketsQuery extends PageQuery {
  /** Só as comandas deste setor (a tela da cozinha de um setor). */
  readonly sectorId?: string;
  /** Um ou mais status separados por vírgula: `WAITING,PREPARING`. Default: todos. */
  readonly status?: string;
  /** Dia de operação (`YYYY-MM-DD`, fuso da filial). Default: todos. */
  readonly businessDate?: string;
}

export interface KitchenTicketItemOptionDto {
  /** Cópias do pedido. */
  readonly groupName: string;
  readonly name: string;
}

export interface KitchenTicketItemDto {
  readonly orderItemId: string;
  readonly productName: string;
  readonly productCode: string | null;
  readonly quantity: number;
  readonly options: readonly KitchenTicketItemOptionDto[];
  readonly note: string | null;
}

export interface KitchenTicketSectorDto {
  readonly id: string;
  /** Nome do setor no momento da confirmação (cópia). */
  readonly name: string;
  readonly code: string;
}

export interface KitchenTicketDto {
  readonly id: string;
  readonly orderId: string;
  /** Número do pedido no dia (o que é chamado no balcão). */
  readonly orderNumber: number;
  readonly businessDate: string;
  readonly sector: KitchenTicketSectorDto;
  readonly status: KitchenTicketStatus;
  /** Sem preços: a cozinha não vê valores. */
  readonly items: readonly KitchenTicketItemDto[];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly cancelledAt: string | null;
  /** Vias impressas até agora (0 = nunca impressa). */
  readonly printCount: number;
  readonly lastPrintedAt: string | null;
}

/** Resumo das comandas no pedido (`OrderDto.kitchenTickets`). */
export interface OrderKitchenTicketDto {
  readonly id: string;
  readonly sector: KitchenTicketSectorDto;
  readonly status: KitchenTicketStatus;
}

export interface KitchenTicketPrintDto {
  readonly ticket: KitchenTicketDto;
  /** Via desta impressão (1 = original). */
  readonly copyNumber: number;
  /**
   * Texto pronto para térmica 80 mm: cada linha com no máximo 48 caracteres (fonte monoespaçada), acentos
   * mantidos (UTF-8). Inclui setor, número do pedido, data/hora no fuso da filial, itens com quantidade, opções e
   * observação, e o cabeçalho "Nª VIA" com o número da via (via ≥ 2) ou "*** CANCELADO ***" (comanda CANCELLED). Sem preços.
   */
  readonly lines: readonly string[];
}
