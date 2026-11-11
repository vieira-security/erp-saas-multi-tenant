import type { OrderStatus } from "@erp/contracts";

/**
 * Máquina de estados do pedido (contrato M5):
 *   EDITING ─confirm▶ CONFIRMED ─start▶ PREPARING ─ready▶ READY ─deliver▶ DELIVERED
 *   EDITING/CONFIRMED/PREPARING/READY/DELIVERED ─cancel▶ CANCELLED   (M6: DELIVERED também, com estorno total)
 * Qualquer outra combinação (inclusive repetir a transição já feita) = 409 `order_invalid_transition`. O banco impõe a
 * mesma tabela no trigger `orders_immutable_after_confirmation` (defesa em profundidade).
 */
export type OrderAction = "confirm" | "start" | "ready" | "deliver" | "cancel";

const TRANSITIONS: Readonly<Record<OrderAction, { readonly from: readonly OrderStatus[]; readonly to: OrderStatus }>> = {
  confirm: { from: ["EDITING"], to: "CONFIRMED" },
  start: { from: ["CONFIRMED"], to: "PREPARING" },
  ready: { from: ["PREPARING"], to: "READY" },
  deliver: { from: ["READY"], to: "DELIVERED" },
  cancel: { from: ["EDITING", "CONFIRMED", "PREPARING", "READY", "DELIVERED"], to: "CANCELLED" },
};

/** Próximo estado, ou `null` se a ação não vale a partir de `from`. */
export function nextStatus(from: OrderStatus, action: OrderAction): OrderStatus | null {
  const transition = TRANSITIONS[action];
  return transition.from.includes(from) ? transition.to : null;
}

/** Pedido já confirmado (tem número e é venda): cancelar exige `order.cancel` e motivo. */
export function isConfirmed(status: OrderStatus): boolean {
  return status !== "EDITING";
}
