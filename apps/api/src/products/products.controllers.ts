import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import type { BranchProductSettingDto, MenuDto, Page, ProductCategoryDto, ProductDto, ProductSummaryDto } from "@erp/contracts";
import { RequireBranchPermissions, RequirePermissions } from "../authorization/permission.guard.js";
import { ProductCategoryStatus, ProductStatus } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID, bool, nullable, oneOf, optional, parseInput, required, text, uuid } from "../http/input.js";
import { money } from "../http/money.js";
import { pageQuerySpec, pageRequest } from "../http/paging.js";
import { BranchProductService } from "./branch-product.service.js";
import { CategoryService } from "./category.service.js";
import { ProductService } from "./product.service.js";
import {
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_QUERY_MAX_LENGTH,
  STATUSES,
  description,
  optionGroups,
  productCode,
  sortOrder,
} from "./validation.js";

/**
 * HTTP do M4 (contratos em `@erp/contracts`, products.ts). Controllers só fazem parsing estrito + autorização declarativa
 * por código de permissão e delegam aos services. Rotas exigem autenticação (AuthGuard global); o tenant vem do token.
 * Catálogo em escopo de TENANT (`product.read`/`product.manage`); rotas `/branches/:branchId/...` em escopo de FILIAL
 * (exigem UserBranchAccess; filial sem acesso, de outro tenant ou inexistente = 403).
 */

/** Id de rota fora do formato UUID = recurso inexistente (404), sem consultar o banco. */
function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

@Controller("product-categories")
export class ProductCategoriesController {
  constructor(@Inject(CategoryService) private readonly categories: CategoryService) {}

  @Get()
  @RequirePermissions("product.read")
  list(@Query() query: unknown): Promise<ProductCategoryDto[]> {
    const { status } = parseInput(query, { status: optional(oneOf(STATUSES)) }, "query");
    return this.categories.list(status ? { status } : {});
  }

  @Post()
  @RequirePermissions("product.manage")
  create(@Body() body: unknown): Promise<ProductCategoryDto> {
    return this.categories.create(parseInput(body, { name: required(text(PRODUCT_CATEGORY_NAME_MAX_LENGTH)), sortOrder: optional(sortOrder) }));
  }

  @Patch(":categoryId")
  @RequirePermissions("product.manage")
  update(@Param("categoryId") categoryId: string, @Body() body: unknown): Promise<ProductCategoryDto> {
    const id = routeId(categoryId, "Product category");
    return this.categories.update(id, parseInput(body, { name: optional(text(PRODUCT_CATEGORY_NAME_MAX_LENGTH)), sortOrder: optional(sortOrder) }));
  }

  @Post(":categoryId/activate")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  activate(@Param("categoryId") categoryId: string): Promise<ProductCategoryDto> {
    return this.categories.setStatus(routeId(categoryId, "Product category"), ProductCategoryStatus.ACTIVE);
  }

  @Post(":categoryId/deactivate")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  deactivate(@Param("categoryId") categoryId: string): Promise<ProductCategoryDto> {
    return this.categories.setStatus(routeId(categoryId, "Product category"), ProductCategoryStatus.INACTIVE);
  }
}

@Controller("products")
export class ProductsController {
  constructor(@Inject(ProductService) private readonly products: ProductService) {}

  @Get()
  @RequirePermissions("product.read")
  list(@Query() query: unknown): Promise<Page<ProductSummaryDto>> {
    const { categoryId, status, q, ...paging } = parseInput(
      query,
      { ...pageQuerySpec, categoryId: optional(uuid), status: optional(oneOf(STATUSES)), q: optional(text(PRODUCT_QUERY_MAX_LENGTH)) },
      "query",
    );
    return this.products.list({ ...(categoryId ? { categoryId } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}) }, pageRequest(paging));
  }

  @Get(":productId")
  @RequirePermissions("product.read")
  get(@Param("productId") productId: string): Promise<ProductDto> {
    return this.products.get(routeId(productId, "Product"));
  }

  @Post()
  @RequirePermissions("product.manage")
  create(@Body() body: unknown): Promise<ProductDto> {
    const input = parseInput(body, {
      name: required(text(PRODUCT_NAME_MAX_LENGTH)),
      description: optional(description),
      code: optional(nullable(productCode)),
      categoryId: optional(nullable(uuid)),
      basePrice: required(money),
      sortOrder: optional(sortOrder),
      optionGroups: optional(optionGroups),
    });
    return this.products.create(input);
  }

  @Patch(":productId")
  @RequirePermissions("product.manage")
  update(@Param("productId") productId: string, @Body() body: unknown): Promise<ProductDto> {
    const id = routeId(productId, "Product");
    const changes = parseInput(body, {
      name: optional(text(PRODUCT_NAME_MAX_LENGTH)),
      description: optional(description),
      code: optional(nullable(productCode)),
      categoryId: optional(nullable(uuid)),
      basePrice: optional(money),
      sortOrder: optional(sortOrder),
    });
    return this.products.update(id, changes);
  }

  @Put(":productId/option-groups")
  @RequirePermissions("product.manage")
  replaceOptionGroups(@Param("productId") productId: string, @Body() body: unknown): Promise<ProductDto> {
    const id = routeId(productId, "Product");
    const input = parseInput(body, { optionGroups: required(optionGroups) });
    return this.products.replaceOptionGroups(id, input.optionGroups);
  }

  @Post(":productId/activate")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  activate(@Param("productId") productId: string): Promise<ProductDto> {
    return this.products.setStatus(routeId(productId, "Product"), ProductStatus.ACTIVE);
  }

  @Post(":productId/deactivate")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  deactivate(@Param("productId") productId: string): Promise<ProductDto> {
    return this.products.setStatus(routeId(productId, "Product"), ProductStatus.INACTIVE);
  }
}

/** Escopo de FILIAL: o guard exige a permissão NA filial `:branchId` (UserBranchAccess), mesmo com role tenant-wide. */
@Controller("branches/:branchId")
export class BranchProductsController {
  constructor(@Inject(BranchProductService) private readonly branchProducts: BranchProductService) {}

  @Get("product-settings")
  @RequireBranchPermissions("branchId", "product.read")
  listSettings(@Param("branchId") branchId: string): Promise<BranchProductSettingDto[]> {
    return this.branchProducts.listSettings(routeId(branchId, "Branch"));
  }

  @Put("product-settings/:productId")
  @RequireBranchPermissions("branchId", "product.manage")
  upsertSetting(@Param("branchId") branchId: string, @Param("productId") productId: string, @Body() body: unknown): Promise<BranchProductSettingDto> {
    const branch = routeId(branchId, "Branch");
    const product = routeId(productId, "Product");
    const input = parseInput(body, { available: required(bool), price: required(nullable(money)) });
    return this.branchProducts.upsert(branch, product, input);
  }

  @Delete("product-settings/:productId")
  @HttpCode(204)
  @RequireBranchPermissions("branchId", "product.manage")
  async removeSetting(@Param("branchId") branchId: string, @Param("productId") productId: string): Promise<void> {
    await this.branchProducts.remove(routeId(branchId, "Branch"), routeId(productId, "Product"));
  }

  @Get("menu")
  @RequireBranchPermissions("branchId", "product.read")
  menu(@Param("branchId") branchId: string): Promise<MenuDto> {
    return this.branchProducts.menu(routeId(branchId, "Branch"));
  }
}
