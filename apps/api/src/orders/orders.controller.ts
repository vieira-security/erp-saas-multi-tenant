import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import type { OrderDto, OrderSummaryDto, Page } from "@erp/contracts";
import { RequireBranchPermissions } from "../authorization/permission.guard.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID, optional, parseInput, required } from "../http/input.js";
import { pageQuerySpec, pageRequest } from "../http/paging.js";
import { OrderService } from "./order.service.js";
import { payments } from "../cash/validation.js";
import { businessDateQuery, cancelReason, orderItems, statusList } from "./validation.js";

/** Id de rota fora do formato UUID = recurso inexistente (404), sem consultar o banco. */
function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

/** Corpo opcional (POST sem corpo chega como `{}` ou `undefined`). */
function optionalBody(body: unknown): unknown {
  return body === undefined || body === null ? {} : body;
}

/**
 * HTTP do M5 (contrato em `@erp/contracts`, orders.ts). TODAS as rotas são de FILIAL: o PermissionGuard exige a
 * permissão NA filial `:branchId` (UserBranchAccess), mesmo para role tenant-wide; sem acesso, filial de outro tenant ou
 * inexistente = 403. Exceção documentada: `cancel` declara só `order.read` na filial e o service decide pelo estado.
 * M7: start/ready exigem `order.prepare` (Proprietário, Gerente, Atendente e Cozinha); deliver continua com `order.create`.
 */
@Controller("branches/:branchId/orders")
export class OrdersController {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}

  @Post()
  @RequireBranchPermissions("branchId", "order.create")
  create(@Param("branchId") branchId: string, @Body() body: unknown): Promise<OrderDto> {
    const input = parseInput(optionalBody(body), { items: optional(orderItems) });
    return this.orders.create(routeId(branchId, "Branch"), input.items ?? []);
  }

  @Get()
  @RequireBranchPermissions("branchId", "order.read")
  list(@Param("branchId") branchId: string, @Query() query: unknown): Promise<Page<OrderSummaryDto>> {
    const { status, businessDate, ...paging } = parseInput(
      query,
      { ...pageQuerySpec, status: optional(statusList), businessDate: optional(businessDateQuery) },
      "query",
    );
    return this.orders.list(
      routeId(branchId, "Branch"),
      { ...(status ? { statuses: status } : {}), ...(businessDate ? { businessDate } : {}) },
      pageRequest(paging),
    );
  }

  @Get(":orderId")
  @RequireBranchPermissions("branchId", "order.read")
  get(@Param("branchId") branchId: string, @Param("orderId") orderId: string): Promise<OrderDto> {
    return this.orders.get(routeId(branchId, "Branch"), routeId(orderId, "Order"));
  }

  @Put(":orderId/items")
  @RequireBranchPermissions("branchId", "order.create")
  replaceItems(@Param("branchId") branchId: string, @Param("orderId") orderId: string, @Body() body: unknown): Promise<OrderDto> {
    const branch = routeId(branchId, "Branch");
    const order = routeId(orderId, "Order");
    const input = parseInput(body, { items: required(orderItems) });
    return this.orders.replaceItems(branch, order, input.items);
  }

  @Post(":orderId/confirm")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.create")
  confirm(@Param("branchId") branchId: string, @Param("orderId") orderId: string, @Body() body: unknown): Promise<OrderDto> {
    const branch = routeId(branchId, "Branch");
    const order = routeId(orderId, "Order");
    // M6: o pedido é pago antes de confirmar (ConfirmOrderRequest).
    const input = parseInput(body, { payments: required(payments) });
    return this.orders.confirm(branch, order, input.payments);
  }

  @Post(":orderId/start")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.prepare")
  start(@Param("branchId") branchId: string, @Param("orderId") orderId: string): Promise<OrderDto> {
    return this.orders.advance(routeId(branchId, "Branch"), routeId(orderId, "Order"), "start");
  }

  @Post(":orderId/ready")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.prepare")
  ready(@Param("branchId") branchId: string, @Param("orderId") orderId: string): Promise<OrderDto> {
    return this.orders.advance(routeId(branchId, "Branch"), routeId(orderId, "Order"), "ready");
  }

  @Post(":orderId/deliver")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.create")
  deliver(@Param("branchId") branchId: string, @Param("orderId") orderId: string): Promise<OrderDto> {
    return this.orders.advance(routeId(branchId, "Branch"), routeId(orderId, "Order"), "deliver");
  }

  /** Mínimo declarativo `order.read` na filial; quem pode cancelar (criador x `order.cancel`) depende do estado. */
  @Post(":orderId/cancel")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.read")
  cancel(@Param("branchId") branchId: string, @Param("orderId") orderId: string, @Body() body: unknown): Promise<OrderDto> {
    const branch = routeId(branchId, "Branch");
    const order = routeId(orderId, "Order");
    const input = parseInput(optionalBody(body), { reason: optional(cancelReason) });
    return this.orders.cancel(branch, order, input.reason);
  }
}
