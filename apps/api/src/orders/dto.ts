import type { OrderDto, OrderItemDto, OrderSummaryDto } from "@erp/contracts";
import type { Order, OrderItem, OrderItemOption } from "../generated/prisma/client.js";
import { toMoney } from "../http/money.js";
import { fromDateColumn } from "./business-date.js";

/** Model Prisma -> contrato HTTP. Só campos do contrato: `tenantId` nunca sai. */

/** `include` do Prisma para OrderDto: itens + opções e o NOME de quem criou/cancelou numa única leitura (sem N+1). */
export const ORDER_DETAIL_INCLUDE = {
  items: { include: { options: true } },
  creator: { select: { id: true, name: true } },
  canceller: { select: { id: true, name: true } },
} as const;

export type OrderWithDetail = Order & {
  items: (OrderItem & { options: OrderItemOption[] })[];
  creator: { id: string; name: string };
  canceller: { id: string; name: string } | null;
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

export function toOrderDto(order: OrderWithDetail): OrderDto {
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
  };
}
