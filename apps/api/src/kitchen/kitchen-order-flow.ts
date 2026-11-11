import { Inject, Injectable } from "@nestjs/common";
import type { KitchenTicketStatus, OrderStatus } from "@erp/contracts";
import { KitchenTicketStatus as DbTicketStatus, type Prisma } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { lockOrderTickets, lockSectorsForRouting, type LockedTicket } from "./kitchen-lock.js";
import { deriveOrderStatus, orderStatusSteps, routeItems, type TicketAction } from "./kitchen-rules.js";

type Tx = Prisma.TransactionClient;

/** Timestamp do pedido gravado ao entrar em cada estado de cozinha (mesmos campos do M5). */
const ORDER_STATE_TIMESTAMP = { PREPARING: "preparingAt", READY: "readyAt" } as const;

/**
 * Comandas dentro das transações do pedido (M5/M6). Sempre com o pedido JÁ TRAVADO por quem chama (FOR UPDATE), e na
 * ordem pedido -> setores/ajustes -> comandas (kitchen-lock.ts). Toda query com TenantScope ou `tenant_id` explícito.
 */
@Injectable()
export class KitchenOrderFlow {
  constructor(@Inject(TenantScope) private readonly scope: TenantScope) {}

  /**
   * Confirmação: uma comanda por setor EFETIVO, só com os itens daquele setor (combo inteiro no setor do produto principal).
   * Chamado depois de o pedido virar CONFIRMED (o trigger da comanda exige isso), com os itens já regravados.
   */
  async createTickets(tx: Tx, branchId: string, orderId: string, now: Date): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: this.scope.where({ orderId }),
      select: { id: true, productId: true },
      orderBy: { sortOrder: "asc" },
    });
    if (items.length === 0) return;
    const products = await tx.product.findMany({
      where: this.scope.where({ id: { in: [...new Set(items.map((i) => i.productId))] } }),
      select: { id: true, kitchenSectorId: true },
    });
    const sectorOf = new Map(products.map((p) => [p.id, p.kitchenSectorId]));
    const sectors = await lockSectorsForRouting(tx, this.scope.tenantId(), branchId);
    const routed = routeItems(
      items.map((i) => ({ orderItemId: i.id, productSectorId: sectorOf.get(i.productId) ?? null })),
      sectors,
    );
    const tickets = await tx.kitchenTicket.createManyAndReturn({
      data: routed.map(({ sector }) =>
        this.scope.data({
          branchId,
          orderId,
          sectorId: sector.id,
          sectorName: sector.name,
          sectorCode: sector.code,
          status: DbTicketStatus.WAITING,
          createdAt: now,
        }),
      ),
      select: { id: true, sectorId: true },
    });
    const ticketOf = new Map(tickets.map((t) => [t.sectorId, t.id]));
    await tx.kitchenTicketItem.createMany({
      data: routed.flatMap(({ sector, orderItemIds }) =>
        orderItemIds.map((orderItemId) => this.scope.data({ orderId, ticketId: ticketOf.get(sector.id)!, orderItemId, createdAt: now })),
      ),
    });
  }

  /** Comandas do pedido, travadas (pedido já travado por quem chama). Vazio = pedido confirmado antes do M7 (legado). */
  async lockTickets(tx: Tx, orderId: string): Promise<LockedTicket[]> {
    return lockOrderTickets(tx, this.scope.tenantId(), orderId);
  }

  /**
   * Move as comandas indicadas pela ação (start: WAITING -> PREPARING; ready: -> READY, gravando também o início se a
   * comanda ainda esperava) e recalcula o status do pedido na MESMA transação.
   */
  async moveTickets(tx: Tx, order: { id: string; status: OrderStatus }, all: readonly LockedTicket[], moved: readonly LockedTicket[], action: TicketAction, now: Date): Promise<void> {
    const target: KitchenTicketStatus = action === "start" ? "PREPARING" : "READY";
    const ids = moved.map((t) => t.id);
    if (action === "start") {
      await tx.kitchenTicket.updateMany({ where: this.scope.where({ orderId: order.id, id: { in: ids } }), data: { status: target, startedAt: now } });
    } else {
      const notStarted = moved.filter((t) => t.startedAt === null).map((t) => t.id);
      const started = moved.filter((t) => t.startedAt !== null).map((t) => t.id);
      if (notStarted.length > 0) {
        await tx.kitchenTicket.updateMany({ where: this.scope.where({ orderId: order.id, id: { in: notStarted } }), data: { status: target, startedAt: now, readyAt: now } });
      }
      if (started.length > 0) {
        await tx.kitchenTicket.updateMany({ where: this.scope.where({ orderId: order.id, id: { in: started } }), data: { status: target, readyAt: now } });
      }
    }
    const statuses = all.map((t) => (ids.includes(t.id) ? target : t.status));
    await this.syncOrderStatus(tx, order, statuses, now);
  }

  /**
   * Status do pedido DERIVADO das comandas: aplica as setas do M5 que faltam (CONFIRMED -> PREPARING -> READY), cada uma
   * gravando o próprio timestamp, como o trigger do pedido exige.
   */
  async syncOrderStatus(tx: Tx, order: { id: string; status: OrderStatus }, statuses: readonly KitchenTicketStatus[], now: Date): Promise<void> {
    const target = deriveOrderStatus(statuses);
    if (target === null) return;
    for (const status of orderStatusSteps(order.status, target)) {
      if (status === "CONFIRMED") continue;
      await tx.order.update({ where: this.scope.where({ id: order.id }), data: { status, [ORDER_STATE_TIMESTAMP[status]]: now } });
    }
  }

  /** Cancelamento do pedido: toda comanda ainda não cancelada vira CANCELLED (nada é apagado). */
  async cancelTickets(tx: Tx, orderId: string, now: Date): Promise<void> {
    await tx.kitchenTicket.updateMany({
      where: this.scope.where({ orderId, status: { not: DbTicketStatus.CANCELLED } }),
      data: { status: DbTicketStatus.CANCELLED, cancelledAt: now },
    });
  }
}
