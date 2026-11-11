import { Inject, Injectable } from "@nestjs/common";
import type { KitchenTicketDto, KitchenTicketPrintDto, KitchenTicketStatus, Page } from "@erp/contracts";
import { CLOCK, type Clock } from "../clock/clock.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../http/api-error.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { dateColumn } from "../orders/business-date.js";
import { lockOrder } from "../orders/order-lock.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { TICKET_DETAIL_INCLUDE, ticketItems, toKitchenTicketDto } from "./dto.js";
import { countPrint } from "./kitchen-lock.js";
import { KitchenOrderFlow } from "./kitchen-order-flow.js";
import { nextTicketStatus, type TicketAction } from "./kitchen-rules.js";
import { ticketLines } from "./print-layout.js";

type Tx = Prisma.TransactionClient;

export interface TicketFilter {
  sectorId?: string;
  statuses?: KitchenTicketStatus[];
  businessDate?: string;
}

/**
 * Comandas da filial (rotas `/branches/:branchId/kitchen-tickets`). Toda query leva TenantScope E a filial da rota:
 * comanda de outra filial ou de outro tenant é 404. O acesso à filial já foi exigido pelo PermissionGuard.
 * - start/ready: trava o PEDIDO e depois as comandas dele (mesma ordem do cancelamento e dos atalhos do pedido), valida a
 *   transição e recalcula o status do pedido na mesma transação (KitchenOrderFlow).
 * - print: conta a via atomicamente (UPDATE ... RETURNING) e devolve o texto pronto (print-layout.ts).
 */
@Injectable()
export class KitchenTicketService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(KitchenOrderFlow) private readonly flow: KitchenOrderFlow,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Ordem de chegada: `createdAt`, depois `id`. */
  async list(branchId: string, filter: TicketFilter, page: PageRequest): Promise<Page<KitchenTicketDto>> {
    const where = this.scope.where({
      branchId,
      ...(filter.sectorId ? { sectorId: filter.sectorId } : {}),
      ...(filter.statuses ? { status: { in: filter.statuses } } : {}),
      ...(filter.businessDate ? { order: { businessDate: dateColumn(filter.businessDate) } } : {}),
    });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.kitchenTicket.findMany({
        where,
        include: TICKET_DETAIL_INCLUDE,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.kitchenTicket.count({ where }),
    ]);
    return toPage(rows, total, page, toKitchenTicketDto);
  }

  async get(branchId: string, ticketId: string): Promise<KitchenTicketDto> {
    return this.load(this.prisma, branchId, ticketId);
  }

  async advance(branchId: string, ticketId: string, action: TicketAction): Promise<KitchenTicketDto> {
    return this.prisma.$transaction(async (tx) => {
      const ref = await tx.kitchenTicket.findFirst({ where: this.scope.where({ id: ticketId, branchId }), select: { orderId: true } });
      if (!ref) throw new NotFoundError("Kitchen ticket");
      const order = await lockOrder(tx, this.scope.tenantId(), branchId, ref.orderId);
      if (!order) throw new NotFoundError("Kitchen ticket");
      const tickets = await this.flow.lockTickets(tx, ref.orderId);
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket || nextTicketStatus(ticket.status, action) === null) throw new ConflictError("kitchen_ticket_invalid_transition");
      await this.flow.moveTickets(tx, { id: ref.orderId, status: order.status }, tickets, [ticket], action, this.clock.now());
      return this.load(tx, branchId, ticketId);
    });
  }

  /** Toda chamada conta uma via (1 = original). Comanda CANCELLED imprime o aviso de cancelamento. */
  async print(branchId: string, ticketId: string): Promise<KitchenTicketPrintDto> {
    return this.prisma.$transaction(async (tx) => {
      const copyNumber = await countPrint(tx, this.scope.tenantId(), branchId, ticketId, this.clock.now());
      if (copyNumber === null) throw new NotFoundError("Kitchen ticket");
      const ticket = await this.loadRow(tx, branchId, ticketId);
      const branch = await tx.branch.findUniqueOrThrow({ where: this.scope.where({ id: branchId }), select: { timezone: true } });
      const dto = toKitchenTicketDto(ticket);
      const lines = ticketLines({
        sectorName: ticket.sectorName,
        orderNumber: dto.orderNumber,
        createdAt: ticket.createdAt,
        timeZone: branch.timezone,
        status: ticket.status,
        copyNumber,
        items: ticketItems(ticket),
      });
      return { ticket: dto, copyNumber, lines };
    });
  }

  private async loadRow(db: Tx | PrismaClient, branchId: string, ticketId: string) {
    const ticket = await db.kitchenTicket.findFirst({ where: this.scope.where({ id: ticketId, branchId }), include: TICKET_DETAIL_INCLUDE });
    if (!ticket) throw new NotFoundError("Kitchen ticket");
    return ticket;
  }

  private async load(db: Tx | PrismaClient, branchId: string, ticketId: string): Promise<KitchenTicketDto> {
    return toKitchenTicketDto(await this.loadRow(db, branchId, ticketId));
  }
}
