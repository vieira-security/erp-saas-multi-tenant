import { Module } from "@nestjs/common";
import { ProductsModule } from "../products/products.module.js";
import { OrdersController } from "./orders.controller.js";
import { OrderService } from "./order.service.js";

/**
 * M5: pedidos de balcão por filial (rascunho, confirmação com número do dia, preparo, entrega e cancelamento).
 * Usa o cardápio da filial do M4 (BranchProductService) para validar e precificar itens; relógio via ClockModule (global).
 */
@Module({
  imports: [ProductsModule],
  controllers: [OrdersController],
  providers: [OrderService],
})
export class OrdersModule {}
