import { Module } from "@nestjs/common";
import { KitchenModule } from "../kitchen/kitchen.module.js";
import { ProductsModule } from "../products/products.module.js";
import { OrdersController } from "./orders.controller.js";
import { OrderService } from "./order.service.js";

/**
 * M5: pedidos de balcão por filial (rascunho, confirmação com número do dia, preparo, entrega e cancelamento).
 * Usa o cardápio da filial do M4 (BranchProductService) para validar e precificar itens; relógio via ClockModule (global).
 * M7: comandas por setor via KitchenOrderFlow (KitchenModule).
 */
@Module({
  imports: [ProductsModule, KitchenModule],
  controllers: [OrdersController],
  providers: [OrderService],
})
export class OrdersModule {}
