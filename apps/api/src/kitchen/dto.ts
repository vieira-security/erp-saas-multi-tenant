import type { BranchKitchenSectorDto, KitchenSectorDto, KitchenTicketDto, KitchenTicketItemDto, OrderKitchenTicketDto } from "@erp/contracts";
import type { KitchenSector, KitchenTicket, KitchenTicketItem, OrderItem, OrderItemOption } from "../generated/prisma/client.js";
import { fromDateColumn } from "../orders/business-date.js";
import { receivesTickets } from "./kitchen-rules.js";

/** Model Prisma -> contrato HTTP (kitchen.ts). Só campos do contrato: `tenantId` nunca sai; sem preços nas comandas. */

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toKitchenSectorDto(sector: KitchenSector): KitchenSectorDto {
  return {
    id: sector.id,
    name: sector.name,
    code: sector.code,
    isDefault: sector.isDefault,
    status: sector.status,
    sortOrder: sector.sortOrder,
    createdAt: sector.createdAt.toISOString(),
    updatedAt: sector.updatedAt.toISOString(),
  };
}

/** Sem ajuste gravado = ligado; o padrão aparece sempre ligado (não pode ser desligado). */
export function toBranchKitchenSectorDto(sector: KitchenSector, stored: { enabled: boolean } | undefined): BranchKitchenSectorDto {
  const enabled = sector.isDefault || (stored?.enabled ?? true);
  return {
    sector: toKitchenSectorDto(sector),
    enabled,
    receivesTickets: receivesTickets({ isDefault: sector.isDefault, status: sector.status, enabledInBranch: enabled }),
  };
}

/** `include` do Prisma para KitchenTicketDto: número/dia do pedido e itens com o snapshot da venda, numa leitura (sem N+1). */
export const TICKET_DETAIL_INCLUDE = {
  order: { select: { number: true, businessDate: true } },
  items: { include: { orderItem: { include: { options: true } } } },
} as const;

export type TicketWithDetail = KitchenTicket & {
  order: { number: number | null; businessDate: Date | null };
  items: (KitchenTicketItem & { orderItem: OrderItem & { options: OrderItemOption[] } })[];
};

function toTicketItemDto(item: OrderItem & { options: OrderItemOption[] }): KitchenTicketItemDto {
  return {
    orderItemId: item.id,
    productName: item.productName,
    productCode: item.productCode,
    quantity: item.quantity,
    options: [...item.options].sort((a, b) => a.sortOrder - b.sortOrder).map((o) => ({ groupName: o.groupName, name: o.name })),
    note: item.note,
  };
}

/** Itens do pedido na ordem do pedido (`sortOrder` do item). */
export function ticketItems(ticket: TicketWithDetail): KitchenTicketItemDto[] {
  return ticket.items
    .map((i) => i.orderItem)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(toTicketItemDto);
}

export function toKitchenTicketDto(ticket: TicketWithDetail): KitchenTicketDto {
  // Comanda só existe para pedido confirmado: número e dia sempre preenchidos (CHECK orders_confirmation_check).
  if (ticket.order.number === null || ticket.order.businessDate === null) throw new Error(`kitchen ticket ${ticket.id} of an unconfirmed order`);
  return {
    id: ticket.id,
    orderId: ticket.orderId,
    orderNumber: ticket.order.number,
    businessDate: fromDateColumn(ticket.order.businessDate),
    sector: { id: ticket.sectorId, name: ticket.sectorName, code: ticket.sectorCode },
    status: ticket.status,
    items: ticketItems(ticket),
    createdAt: ticket.createdAt.toISOString(),
    startedAt: iso(ticket.startedAt),
    readyAt: iso(ticket.readyAt),
    cancelledAt: iso(ticket.cancelledAt),
    printCount: ticket.printCount,
    lastPrintedAt: iso(ticket.lastPrintedAt),
  };
}

/** Resumo para `OrderDto.kitchenTickets`, na ordem `createdAt`, depois `id`. */
export function toOrderKitchenTicketDtos(
  tickets: readonly Pick<KitchenTicket, "id" | "sectorId" | "sectorName" | "sectorCode" | "status" | "createdAt">[],
): OrderKitchenTicketDto[] {
  return [...tickets]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({ id: t.id, sector: { id: t.sectorId, name: t.sectorName, code: t.sectorCode }, status: t.status }));
}
