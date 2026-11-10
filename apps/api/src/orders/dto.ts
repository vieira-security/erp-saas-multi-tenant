import type { OrderDto, OrderItemDto, OrderSummaryDto, PaymentDto, RefundDto } from "@erp/contracts";
import { sumMoney } from "../cash/cash-math.js";
import type { Order, OrderItem, OrderItemOption, Payment, Refund } from "../generated/prisma/client.js";
import { toMoney } from "../http/money.js";
import { fromDateColumn } from "./business-date.js";

/** Model Prisma -> contrato HTTP. Só campos do contrato: `tenantId` nunca sai. */

/** `include` do Prisma para OrderDto: itens + opções e o NOME de quem criou/cancelou numa única leitura (sem N+1). */
export const ORDER_DETAIL_INCLUDE = {
  items: { include: { options: true } },
  creator: { select: { id: true, name: true } },
  canceller: { select: { id: true, name: true } },
  // M6: pagamentos com o estorno de cada um (no máximo um), na mesma leitura.
  payments: { include: { refund: true } },
} as const;

export type OrderWithDetail = Order & {
  items: (OrderItem & { options: OrderItemOption[] })[];
  creator: { id: string; name: string };
  canceller: { id: string; name: string } | null;
  payments: (Payment & { refund: Refund | null })[];
};

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toOrderSummaryDto(order: Order & { _count: { items: number } }): OrderSummaryDto {
  return {
    id: order.id,
    branchId: order.branchId,
    number: order.number,
    businessDate: order.businessDate ? fromDateColumn(order.businessDate) : null,
    status: order.status,
    itemCount: order._count.items,
    total: toMoney(order.total),
    createdAt: order.createdAt.toISOString(),
    confirmedAt: iso(order.confirmedAt),
  };
}

function toItemDto(item: OrderItem & { options: OrderItemOption[] }): OrderItemDto {
  return {
    id: item.id,
    productId: item.productId,
    productName: item.productName,
    productCode: item.productCode,
    quantity: item.quantity,
    unitPrice: toMoney(item.unitPrice),
    lineTotal: toMoney(item.lineTotal),
    options: [...item.options]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((o) => ({ optionId: o.optionId, groupName: o.groupName, name: o.name, priceDelta: toMoney(o.priceDelta), linkedProductId: o.linkedProductId })),
    note: item.note,
  };
}

/** Criação, depois id (pagamentos do mesmo pedido são gravados juntos na confirmação). */
function byCreation<T extends { createdAt: Date; id: string }>(a: T, b: T): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function toPaymentDto(p: Payment): PaymentDto {
  return {
    id: p.id,
    method: p.method,
    amount: toMoney(p.amount),
    receivedAmount: p.receivedAmount === null ? null : toMoney(p.receivedAmount),
    change: toMoney(p.change),
    reference: p.reference,
    cashSessionId: p.cashSessionId,
    createdAt: p.createdAt.toISOString(),
  };
}

function toRefundDto(r: Refund): RefundDto {
  return { id: r.id, paymentId: r.paymentId, method: r.method, amount: toMoney(r.amount), cashSessionId: r.cashSessionId, createdAt: r.createdAt.toISOString() };
}

export function toOrderDto(order: OrderWithDetail): OrderDto {
  const payments = [...order.payments].sort(byCreation);
  return {
    ...toOrderSummaryDto({ ...order, _count: { items: order.items.length } }),
    items: [...order.items].sort((a, b) => a.sortOrder - b.sortOrder).map(toItemDto),
    createdBy: { userId: order.creator.id, name: order.creator.name },
    preparingAt: iso(order.preparingAt),
    readyAt: iso(order.readyAt),
    deliveredAt: iso(order.deliveredAt),
    cancelledAt: iso(order.cancelledAt),
    cancelledBy: order.canceller ? { userId: order.canceller.id, name: order.canceller.name } : null,
    cancelReason: order.cancelReason,
    payments: payments.map(toPaymentDto),
    refunds: payments.flatMap((p) => (p.refund ? [p.refund] : [])).sort(byCreation).map(toRefundDto),
    changeGiven: sumMoney(payments.map((p) => toMoney(p.change))),
  };
}
