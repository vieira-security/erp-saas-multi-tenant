import type {
  BranchProductSettingDto,
  ProductCategoryDto,
  ProductDto,
  ProductOptionGroupDto,
  ProductSummaryDto,
} from "@erp/contracts";
import type { BranchProductSetting, Product, ProductCategory, ProductOption, ProductOptionGroup } from "../generated/prisma/client.js";
import { toMoney } from "../http/money.js";
import { compareOrdered } from "./menu.js";

/** Model Prisma -> contrato HTTP. Só campos do contrato: `tenantId` (e `productId` interno das opções) nunca sai. */

export function toCategoryDto(category: ProductCategory): ProductCategoryDto {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    status: category.status,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

export function toProductSummaryDto(product: Product & { _count: { optionGroups: number } }): ProductSummaryDto {
  return {
    id: product.id,
    categoryId: product.categoryId,
    // M7 (contrato #26): placeholder até a implementação dos setores; `null` = setor padrão.
    kitchenSectorId: null,
    name: product.name,
    code: product.code,
    basePrice: toMoney(product.basePrice),
    sortOrder: product.sortOrder,
    status: product.status,
    optionGroupCount: product._count.optionGroups,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export type ProductWithGroups = Product & { optionGroups: (ProductOptionGroup & { options: ProductOption[] })[] };

/** `include` do Prisma correspondente a ProductWithGroups. A ordem final é aplicada em memória (compareOrdered). */
export const PRODUCT_WITH_GROUPS = { optionGroups: { include: { options: true } } } as const;

export function toOptionGroupDto(group: ProductOptionGroup & { options: ProductOption[] }): ProductOptionGroupDto {
  return {
    id: group.id,
    name: group.name,
    minChoices: group.minChoices,
    maxChoices: group.maxChoices,
    sortOrder: group.sortOrder,
    options: [...group.options].sort(compareOrdered).map((option) => ({
      id: option.id,
      name: option.name,
      priceDelta: toMoney(option.priceDelta),
      linkedProductId: option.linkedProductId,
      sortOrder: option.sortOrder,
    })),
  };
}

export function toProductDto(product: ProductWithGroups): ProductDto {
  return {
    id: product.id,
    categoryId: product.categoryId,
    // M7 (contrato #26): placeholder até a implementação dos setores; `null` = setor padrão.
    kitchenSectorId: null,
    name: product.name,
    description: product.description,
    code: product.code,
    basePrice: toMoney(product.basePrice),
    sortOrder: product.sortOrder,
    status: product.status,
    optionGroups: [...product.optionGroups].sort(compareOrdered).map(toOptionGroupDto),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toBranchProductSettingDto(setting: BranchProductSetting): BranchProductSettingDto {
  return {
    branchId: setting.branchId,
    productId: setting.productId,
    available: setting.available,
    price: setting.price === null ? null : toMoney(setting.price),
    updatedAt: setting.updatedAt.toISOString(),
  };
}
