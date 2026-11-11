import type { KitchenSectorStatus, KitchenTicketStatus, OrderStatus } from "@erp/contracts";

/**
 * Regras puras do M7 (sem banco; decisões de produto de 10/11/2026, contrato `packages/contracts/src/kitchen.ts`).
 */

/** Setor como a confirmação o enxerga: estado no tenant + ligado/desligado NESTA filial (sem ajuste = ligado). */
export interface RoutableSector {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isDefault: boolean;
  readonly status: KitchenSectorStatus;
  readonly enabledInBranch: boolean;
}

/** O setor recebe comandas na filial: o padrão sempre; os demais se ACTIVE no tenant E ligados na filial. */
export function receivesTickets(sector: Pick<RoutableSector, "isDefault" | "status" | "enabledInBranch">): boolean {
  return sector.isDefault || (sector.status === "ACTIVE" && sector.enabledInBranch);
}

/** Invariante quebrada: o tenant ficou sem setor padrão (o provisionamento e a migration criam um). */
export class DefaultKitchenSectorMissingError extends Error {
  override readonly name = "DefaultKitchenSectorMissingError";
  constructor() {
    super("The tenant has no default kitchen sector (provisioning creates one)");
  }
}

/**
 * Setor EFETIVO de um item: o setor do produto principal se ele recebe comandas nesta filial; senão (produto sem setor,
 * setor INACTIVE no tenant, desligado na filial ou inexistente) o setor padrão. Combo vai inteiro no setor do produto
 * principal: opções e produtos vinculados não entram aqui.
 */
export function effectiveSector(productSectorId: string | null, sectors: readonly RoutableSector[]): RoutableSector {
  const fallback = sectors.find((s) => s.isDefault);
  if (!fallback) throw new DefaultKitchenSectorMissingError();
  if (productSectorId === null) return fallback;
  const own = sectors.find((s) => s.id === productSectorId);
  return own && receivesTickets(own) ? own : fallback;
}

export interface RoutableItem {
  readonly orderItemId: string;
  /** Setor do PRODUTO PRINCIPAL do item (`products.kitchen_sector_id`). */
  readonly productSectorId: string | null;
}

/**
 * Uma comanda por setor efetivo, só com os itens daquele setor (itens na ordem recebida, a do pedido). Comandas na ordem
 * do primeiro item de cada setor.
 */
export function routeItems(items: readonly RoutableItem[], sectors: readonly RoutableSector[]): { sector: RoutableSector; orderItemIds: string[] }[] {
  const tickets = new Map<string, { sector: RoutableSector; orderItemIds: string[] }>();
  for (const item of items) {
    const sector = effectiveSector(item.productSectorId, sectors);
    const ticket = tickets.get(sector.id) ?? { sector, orderItemIds: [] };
    ticket.orderItemIds.push(item.orderItemId);
    tickets.set(sector.id, ticket);
  }
  return [...tickets.values()];
}

/**
 * Fluxo da comanda: WAITING ─start▶ PREPARING ─ready▶ READY. Fora da ordem (inclusive repetir, ou comanda CANCELLED) =
 * `null` -> 409 `kitchen_ticket_invalid_transition`.
 */
export type TicketAction = "start" | "ready";

const TICKET_TRANSITIONS: Readonly<Record<TicketAction, { readonly from: KitchenTicketStatus; readonly to: KitchenTicketStatus }>> = {
  start: { from: "WAITING", to: "PREPARING" },
  ready: { from: "PREPARING", to: "READY" },
};

export function nextTicketStatus(from: KitchenTicketStatus, action: TicketAction): KitchenTicketStatus | null {
  const transition = TICKET_TRANSITIONS[action];
  return transition.from === from ? transition.to : null;
}

/**
 * Atalho do pedido (`POST /orders/:id/start|ready`): comandas que ele move. start: as WAITING; ready: as abertas
 * (WAITING ou PREPARING). Lista vazia -> 409 `order_invalid_transition`.
 */
export function shortcutTargets<T extends { readonly status: KitchenTicketStatus }>(tickets: readonly T[], action: TicketAction): T[] {
  return tickets.filter((t) => (action === "start" ? t.status === "WAITING" : t.status === "WAITING" || t.status === "PREPARING"));
}

/** Status de cozinha do pedido (os únicos que as comandas derivam). */
export type KitchenOrderStatus = Extract<OrderStatus, "CONFIRMED" | "PREPARING" | "READY">;

/**
 * Status do pedido DERIVADO das comandas (CANCELLED fica de fora: só existe com o pedido cancelado):
 * todas WAITING = CONFIRMED; todas READY = READY; qualquer outra mistura (alguma PREPARING, ou parte READY) = PREPARING.
 * `null` = nenhuma comanda aberta para derivar.
 */
export function deriveOrderStatus(statuses: readonly KitchenTicketStatus[]): KitchenOrderStatus | null {
  const open = statuses.filter((s) => s !== "CANCELLED");
  if (open.length === 0) return null;
  if (open.every((s) => s === "WAITING")) return "CONFIRMED";
  if (open.every((s) => s === "READY")) return "READY";
  return "PREPARING";
}

const KITCHEN_ORDER_FLOW: readonly KitchenOrderStatus[] = ["CONFIRMED", "PREPARING", "READY"];

/**
 * Transições do pedido para chegar ao status derivado, uma seta do M5 por vez (o trigger do pedido só aceita
 * CONFIRMED>PREPARING e PREPARING>READY): CONFIRMED -> READY vira [PREPARING, READY]. Sem caminho para trás: estado atual
 * igual ou adiante do alvo (ou fora do fluxo de cozinha) = nenhuma transição.
 */
export function orderStatusSteps(current: OrderStatus, target: KitchenOrderStatus): KitchenOrderStatus[] {
  const from = KITCHEN_ORDER_FLOW.indexOf(current as KitchenOrderStatus);
  const to = KITCHEN_ORDER_FLOW.indexOf(target);
  if (from < 0 || to <= from) return [];
  return KITCHEN_ORDER_FLOW.slice(from + 1, to + 1);
}

/** Ordem de exibição dos setores: padrão primeiro, depois `sortOrder`, `name` por código (sem collation) e `id`. */
export function compareSectors(
  a: { readonly isDefault: boolean; readonly sortOrder: number; readonly name: string; readonly id: string },
  b: { readonly isDefault: boolean; readonly sortOrder: number; readonly name: string; readonly id: string },
): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
