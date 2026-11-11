import { Module } from "@nestjs/common";
import { BranchKitchenController, KitchenSectorsController } from "./kitchen.controllers.js";
import { KitchenOrderFlow } from "./kitchen-order-flow.js";
import { KitchenSectorService } from "./kitchen-sector.service.js";
import { KitchenTicketService } from "./kitchen-ticket.service.js";

/**
 * M7: setores de preparo (tenant + liga/desliga por filial), comandas por setor e impressão pelo navegador.
 * Exporta o KitchenOrderFlow para os pedidos (confirmação cria as comandas; start/ready do pedido viram atalho;
 * cancelamento cancela as comandas), sem dependência circular: a cozinha só usa as travas de pedido (order-lock.ts).
 */
@Module({
  controllers: [KitchenSectorsController, BranchKitchenController],
  providers: [KitchenSectorService, KitchenTicketService, KitchenOrderFlow],
  exports: [KitchenOrderFlow],
})
export class KitchenModule {}
