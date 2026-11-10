import { Module } from "@nestjs/common";
import { BranchProductService } from "./branch-product.service.js";
import { CategoryService } from "./category.service.js";
import { ProductService } from "./product.service.js";
import { BranchProductsController, ProductCategoriesController, ProductsController } from "./products.controllers.js";

/**
 * M4: categorias, produtos (grupos de opções: variação/adicional/combo), ajustes por filial e cardápio da filial.
 * Erros `ApiError` -> `{ error, details? }` pelo ApiExceptionFilter global (registrado no OrganizationModule).
 */
@Module({
  controllers: [ProductCategoriesController, ProductsController, BranchProductsController],
  providers: [CategoryService, ProductService, BranchProductService],
  // M5: pedidos usam o mesmo cardápio da filial para validar e precificar itens (sem duplicar regras).
  exports: [BranchProductService],
})
export class ProductsModule {}
