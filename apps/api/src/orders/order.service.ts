import { Inject, Injectable } from "@nestjs/common";
import type { OrderDto, OrderStatus, OrderSummaryDto, Page } from "@erp/contracts";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PermissionDeniedError } from "../auth/errors.js";
import { AuthorizationService, branchScope } from "../authorization/authorization.service.js";
import { CLOCK, type Clock } from "../clock/clock.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { uuidV7 } from "../database/uuid-v7.js";
import { OrderStatus as DbStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, ConflictWithDetailsError, NotFoundError, ValidationFailedError } from "../http/api-error.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { BranchProductService } from "../products/branch-product.service.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { businessDate, dateColumn } from "./business-date.js";
import { ORDER_DETAIL_INCLUDE, toOrderDto, toOrderSummaryDto } from "./dto.js";
import { lockBranchAndCompany, lockOrder, nextOrderNumber } from "./order-lock.js";
import { isConfirmed, nextStatus, type OrderAction } from "./order-state.js";
import { priceItems, type OrderItemValue, type PricedItem } from "./pricing.js";

type Tx = Prisma.TransactionClient;

/** Total acima de numeric(12,2): 400 em `items` (documentado em docs/api.md; o contrato não tem código próprio). */
const TOTAL_OVERFLOW = new ValidationFailedError([{ field: "items", issue: "invalid_value" }]);

/** Timestamp gravado por cada transição de estado (a partir do relógio injetável). */
const STATE_TIMESTAMP: Readonly<Record<"start" | "ready" | "deliver", "preparingAt" | "readyAt" | "deliveredAt">> = {
  start: "preparingAt",
  ready: "readyAt",
  deliver: "deliveredAt",
};

/**
 * Pedidos de balcão (M5). Toda query leva TenantScope E a filial da rota: pedido de outra filial ou de outro tenant é 404.
 * O acesso à filial já foi exigido pelo PermissionGuard (`@RequireBranchPermissions`).
 * - Itens são validados e precificados com o cardápio da filial do M4 (BranchProductService.menu + pricing.ts), dentro da
 *   própria transação; na confirmação tudo é recalculado a partir do cardápio vigente.
 * - Confirmação: pedido travado FOR UPDATE, filial/empresa FOR SHARE (ACTIVE), dia no fuso da filial, número pelo
 *   contador atômico. Transições travam o pedido e seguem order-state.ts.
 * - Cancelamento depende do estado e de quem criou: a rota exige só `order.read` na filial e ESTE service decide com as
 *   permissões efetivas do ator naquela filial (exceção documentada ao padrão declarativo, ver docs/security.md).
 */
@Injectable()
export class OrderService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(BranchProductService) private readonly menus: BranchProductService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Mais recentes primeiro (`createdAt` desc, `id` desc) — exceção à ordem padrão, prevista no contrato. */
  async list(branchId: string, filter: { statuses?: OrderStatus[]; businessDate?: string }, page: PageRequest): Promise<Page<OrderSummaryDto>> {
    const where = this.scope.where({
      branchId,
      ...(filter.statuses ? { status: { in: filter.statuses } } : {}),
      ...(filter.businessDate ? { businessDate: dateColumn(filter.businessDate) } : {}),
    });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: { _count: { select: { items: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(rows, total, page, toOrderSummaryDto);
  }

  async get(branchId: string, orderId: string): Promise<OrderDto> {
    return this.load(this.prisma, branchId, orderId);
  }

  /** Rascunho (EDITING) do ator autenticado, com itens opcionais. Filial e empresa precisam estar ACTIVE. */
  async create(branchId: string, items: readonly OrderItemValue[]): Promise<OrderDto> {
    const { userId } = this.auth.require();
    return this.prisma.$transaction(async (tx) => {
      await this.requireActiveBranch(tx, branchId);
      const priced = await this.price(tx, branchId, items, "draft");
      const order = await tx.order.create({
        data: this.scope.data({ branchId, status: DbStatus.EDITING, total: priced.total, createdBy: userId }),
      });
      await this.writeItems(tx, order.id, priced.items);
      return this.load(tx, branchId, order.id);
    });
  }

  /** Substitui TODOS os itens; só em EDITING (409 `order_not_editable`). */
  async replaceItems(branchId: string, orderId: string, items: readonly OrderItemValue[]): Promise<OrderDto> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, branchId, orderId);
      if (order.status !== DbStatus.EDITING) throw new ConflictError("order_not_editable");
      const priced = await this.price(tx, branchId, items, "draft");
      await this.deleteItems(tx, orderId);
      await this.writeItems(tx, orderId, priced.items);
      await tx.order.update({ where: this.scope.where({ id: orderId }), data: { total: priced.total } });
      return this.load(tx, branchId, orderId);
    });
  }

  async confirm(branchId: string, orderId: string): Promise<OrderDto> {
    const tenantId = this.scope.tenantId();
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, branchId, orderId);
      if (nextStatus(order.status, "confirm") === null) throw new ConflictError("order_invalid_transition");
      const stored = await tx.orderItem.findMany({
        where: this.scope.where({ orderId }),
        include: { options: true },
        orderBy: { sortOrder: "asc" },
      });
      if (stored.length === 0) throw new ConflictError("order_empty");
      const branch = await this.requireActiveBranch(tx, branchId);
      // Recalcula tudo com o cardápio vigente: vale o preço/disponibilidade da confirmação, não o do rascunho.
      const items = stored.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        optionIds: [...item.options].sort((a, b) => a.sortOrder - b.sortOrder).map((o) => o.optionId),
        note: item.note,
      }));
      const priced = await this.price(tx, branchId, items, "confirm");
      const now = this.clock.now();
      const day = businessDate(now, branch.timezone);
      const number = await nextOrderNumber(tx, tenantId, branchId, day, uuidV7(now.getTime()));
      // Itens regravados ANTES de sair de EDITING (o trigger só aceita mudança de itens com o pedido EDITING).
      await this.deleteItems(tx, orderId);
      await this.writeItems(tx, orderId, priced.items);
      await tx.order.update({
        where: this.scope.where({ id: orderId }),
        data: { status: DbStatus.CONFIRMED, total: priced.total, number, businessDate: dateColumn(day), confirmedAt: now },
      });
      return this.load(tx, branchId, orderId);
    });
  }

  /** start/ready/deliver: trava, valida a transição (repetir = 409) e grava o timestamp do novo estado. */
  async advance(branchId: string, orderId: string, action: "start" | "ready" | "deliver"): Promise<OrderDto> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, branchId, orderId);
      const status = nextStatus(order.status, action);
      if (status === null) throw new ConflictError("order_invalid_transition");
      await tx.order.update({ where: this.scope.where({ id: orderId }), data: { status, [STATE_TIMESTAMP[action]]: this.clock.now() } });
      return this.load(tx, branchId, orderId);
    });
  }

  /**
   * EDITING: quem criou (com `order.create`) ou quem tem `order.cancel`; motivo opcional.
   * CONFIRMED/PREPARING/READY: só `order.cancel` NA FILIAL, motivo obrigatório. DELIVERED/CANCELLED: 409.
   */
  async cancel(branchId: string, orderId: string, reason: string | undefined): Promise<OrderDto> {
    const { userId } = this.auth.require();
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, branchId, orderId);
      if (nextStatus(order.status, "cancel" satisfies OrderAction) === null) throw new ConflictError("order_invalid_transition");
      const permissions = await this.authorization.getEffectivePermissions(userId, branchScope(branchId));
      const allowed = isConfirmed(order.status)
        ? permissions.has("order.cancel")
        : permissions.has("order.cancel") || (order.createdBy === userId && permissions.has("order.create"));
      if (!allowed) throw new PermissionDeniedError();
      if (isConfirmed(order.status) && reason === undefined) throw new ValidationFailedError([{ field: "reason", issue: "required" }]);
      await tx.order.update({
        where: this.scope.where({ id: orderId }),
        data: { status: DbStatus.CANCELLED, cancelledAt: this.clock.now(), cancelledBy: userId, cancelReason: reason ?? null },
      });
      return this.load(tx, branchId, orderId);
    });
  }

  private async load(db: Tx | PrismaClient, branchId: string, orderId: string): Promise<OrderDto> {
    const order = await db.order.findFirst({ where: this.scope.where({ id: orderId, branchId }), include: ORDER_DETAIL_INCLUDE });
    if (!order) throw new NotFoundError("Order");
    return toOrderDto(order);
  }

  private async lock(tx: Tx, branchId: string, orderId: string) {
    const order = await lockOrder(tx, this.scope.tenantId(), branchId, orderId);
    if (!order) throw new NotFoundError("Order");
    return order;
  }

  private async requireActiveBranch(tx: Tx, branchId: string) {
    const branch = await lockBranchAndCompany(tx, this.scope.tenantId(), branchId);
    // A rota já exigiu acesso à filial (que prova que ela existe no tenant); ausência aqui seria inconsistência.
    if (!branch) throw new NotFoundError("Branch");
    if (branch.branchStatus !== "ACTIVE") throw new ConflictError("branch_inactive");
    if (branch.companyStatus !== "ACTIVE") throw new ConflictError("company_inactive");
    return branch;
  }

  /** Rascunho: item inválido = 400 com caminho. Confirmação: o mesmo problema = 409 `order_item_unavailable`. */
  private async price(tx: Tx, branchId: string, items: readonly OrderItemValue[], mode: "draft" | "confirm") {
    if (items.length === 0) return { items: [] as PricedItem[], total: "0.00" };
    const result = priceItems(items, await this.menus.menu(branchId, tx));
    if (result.ok) return result;
    if ("overflow" in result) throw TOTAL_OVERFLOW;
    if (mode === "confirm") throw new ConflictWithDetailsError("order_item_unavailable", result.issues);
    throw new ValidationFailedError(result.issues);
  }

  private async deleteItems(tx: Tx, orderId: string): Promise<void> {
    const items = await tx.orderItem.findMany({ where: this.scope.where({ orderId }), select: { id: true } });
    if (items.length === 0) return;
    await tx.orderItemOption.deleteMany({ where: this.scope.where({ orderItemId: { in: items.map((i) => i.id) } }) });
    await tx.orderItem.deleteMany({ where: this.scope.where({ orderId }) });
  }

  /** Dois comandos: itens (com RETURNING) e todas as opções. A posição na lista vira o `sortOrder`. */
  private async writeItems(tx: Tx, orderId: string, items: readonly PricedItem[]): Promise<void> {
    if (items.length === 0) return;
    const created = await tx.orderItem.createManyAndReturn({
      data: items.map((item, index) =>
        this.scope.data({
          orderId,
          productId: item.productId,
          productName: item.productName,
          productCode: item.productCode,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          note: item.note,
          sortOrder: index,
        }),
      ),
      select: { id: true, sortOrder: true },
    });
    const itemIdAt = new Map(created.map((c) => [c.sortOrder, c.id]));
    const options = items.flatMap((item, itemIndex) =>
      item.options.map((option, index) =>
        this.scope.data({
          orderItemId: itemIdAt.get(itemIndex)!,
          optionId: option.optionId,
          groupName: option.groupName,
          name: option.name,
          priceDelta: option.priceDelta,
          linkedProductId: option.linkedProductId,
          sortOrder: index,
        }),
      ),
    );
    if (options.length > 0) await tx.orderItemOption.createMany({ data: options });
  }
}
