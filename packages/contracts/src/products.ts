import type { PageQuery } from "./common.js";

/**
 * M4 — Produtos e cardápio.
 *
 * Modelo (decisões de produto de 07/11/2026):
 * - Cardápio ÚNICO por tenant: categorias e produtos são cadastrados uma vez. Cada filial pode desligar um produto e/ou
 *   sobrescrever o preço base (BranchProductSettings). Sem ajuste = disponível com o preço base.
 * - Variações, adicionais e combos são GRUPOS DE OPÇÕES do produto:
 *     variação  = grupo obrigatório de 1 escolha     (Tamanho: P +0,00 | M +4,00 | G +7,00; minChoices 1, maxChoices 1)
 *     adicional = grupo opcional de N escolhas       (Extras: Bacon +4,00 | Cheddar +3,00; minChoices 0, maxChoices 2)
 *     combo     = grupo cujas opções apontam para outros produtos (Bebida: Coca-Cola | Suco; `linkedProductId`)
 *   Preço final de um item = preço do produto na filial + soma dos `priceDelta` das opções escolhidas. O preço próprio de
 *   um produto vinculado (combo) NÃO entra: só o `priceDelta` da opção.
 * - Sem exclusão de categoria/produto: status ACTIVE/INACTIVE. Grupos e opções são substituídos em bloco
 *   (PUT .../option-groups); pedidos futuros guardam cópia de nome/preço, não dependem das linhas antigas.
 * - Imagens: fora do M4 (upload entra com o armazenamento S3).
 *
 * Dinheiro (`Money`): string decimal em reais com exatamente 2 casas, ponto como separador (`"12.50"`). Nunca number:
 * evita erro de ponto flutuante. Requests aceitam `"12"`, `"12.5"` ou `"12.50"`; valor ≥ 0 e ≤ `"9999999999.99"`.
 *
 * ── Categorias ──────────────────────────────────────────────────────────────────────────────────────────────────────
 * GET   /product-categories                         `product.read`   query ListProductCategoriesQuery -> 200 ProductCategoryDto[]
 * POST  /product-categories                         `product.manage` CreateProductCategoryRequest -> 201 ProductCategoryDto
 * PATCH /product-categories/:categoryId             `product.manage` UpdateProductCategoryRequest -> 200 | 404
 * POST  /product-categories/:categoryId/activate    `product.manage` -> 200 | 404
 * POST  /product-categories/:categoryId/deactivate  `product.manage` -> 200 | 404
 *        Desativar categoria não desativa os produtos: no cardápio eles aparecem sem categoria.
 *
 * ── Produtos ────────────────────────────────────────────────────────────────────────────────────────────────────────
 * GET   /products                                   `product.read`   query ListProductsQuery -> 200 Page<ProductSummaryDto>
 * GET   /products/:productId                        `product.read`   -> 200 ProductDto (com grupos e opções) | 404
 * POST  /products                                   `product.manage` CreateProductRequest -> 201 ProductDto
 *        404 not_found (categoryId/linkedProductId) | 409 product_code_already_exists | 409 linked_product_invalid
 * PATCH /products/:productId                        `product.manage` UpdateProductRequest -> 200 ProductDto | 404 | 409
 * PUT   /products/:productId/option-groups          `product.manage` ReplaceOptionGroupsRequest -> 200 ProductDto
 *        Substitui TODOS os grupos/opções do produto (lista vazia remove todos). 404 | 409 linked_product_invalid
 * POST  /products/:productId/activate               `product.manage` -> 200 ProductDto | 404
 * POST  /products/:productId/deactivate             `product.manage` -> 200 ProductDto | 404
 *
 * ── Por filial (exigem acesso à filial: UserBranchAccess) ──────────────────────────────────────────────────────────
 * GET    /branches/:branchId/product-settings              `product.read`   NA FILIAL -> 200 BranchProductSettingDto[]
 * PUT    /branches/:branchId/product-settings/:productId   `product.manage` NA FILIAL UpsertBranchProductSettingRequest
 *                                                           -> 200 BranchProductSettingDto | 404 (produto)
 * DELETE /branches/:branchId/product-settings/:productId   `product.manage` NA FILIAL -> 204 (volta ao padrão; idempotente)
 * GET    /branches/:branchId/menu                          `product.read`   NA FILIAL -> 200 MenuDto
 *        Sem acesso à filial (ou filial de outro tenant/inexistente) -> 403 forbidden.
 */

/** Decimal em reais, 2 casas, ponto: `"12.50"`. */
export type Money = string;

export const MONEY_MAX = "9999999999.99";
/** Formato aceito em requests (antes da normalização para 2 casas). */
export const MONEY_INPUT_PATTERN = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_CATEGORY_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ProductCategoryStatus = (typeof PRODUCT_CATEGORY_STATUSES)[number];

// ── Categorias ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProductCategoryDto {
  readonly id: string;
  readonly name: string;
  /** Ordem de exibição crescente (empate: criação). */
  readonly sortOrder: number;
  readonly status: ProductCategoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListProductCategoriesQuery {
  readonly status?: ProductCategoryStatus;
}

export interface CreateProductCategoryRequest {
  /** 1–80 caracteres após trim. */
  readonly name: string;
  /** 0–9999; default 0. */
  readonly sortOrder?: number;
}

export interface UpdateProductCategoryRequest {
  readonly name?: string;
  readonly sortOrder?: number;
}

// ── Produtos ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Linha de listagem (sem grupos). */
export interface ProductSummaryDto {
  readonly id: string;
  readonly categoryId: string | null;
  /** M7: setor de preparo do tenant; `null` = setor padrão. */
  readonly kitchenSectorId: string | null;
  readonly name: string;
  /** Código curto para busca rápida no PDV; `null` = sem código. Mesmo formato de `Branch.code`. */
  readonly code: string | null;
  readonly basePrice: Money;
  readonly sortOrder: number;
  readonly status: ProductStatus;
  /** Quantidade de grupos de opções (atalho para a listagem). */
  readonly optionGroupCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProductDto extends Omit<ProductSummaryDto, "optionGroupCount"> {
  readonly description: string | null;
  readonly optionGroups: readonly ProductOptionGroupDto[];
}

export interface ProductOptionGroupDto {
  readonly id: string;
  readonly name: string;
  /** 0 = opcional. */
  readonly minChoices: number;
  readonly maxChoices: number;
  readonly sortOrder: number;
  readonly options: readonly ProductOptionDto[];
}

export interface ProductOptionDto {
  readonly id: string;
  readonly name: string;
  /** Acréscimo ao preço do item; ≥ 0. */
  readonly priceDelta: Money;
  /** Produto vinculado (combo); `null` = opção simples. */
  readonly linkedProductId: string | null;
  readonly sortOrder: number;
}

export interface ListProductsQuery extends PageQuery {
  readonly categoryId?: string;
  readonly status?: ProductStatus;
  /** Busca por nome (contém, sem diferenciar maiúsculas) ou código exato. 1–80 caracteres. */
  readonly q?: string;
}

export interface CreateProductRequest {
  /** 1–120 caracteres após trim. */
  readonly name: string;
  /** Até 500 caracteres; vazio/`null` = sem descrição. */
  readonly description?: string | null;
  /** Trim + maiúsculo, `^[A-Z0-9][A-Z0-9_-]{0,31}$`; único por tenant. `null`/ausente = sem código. */
  readonly code?: string | null;
  /** Categoria do tenant (qualquer status); `null`/ausente = sem categoria. */
  readonly categoryId?: string | null;
  /** M7: setor do tenant (qualquer status; inexistente/de outro tenant -> `invalid_value`). `null`/ausente = padrão. */
  readonly kitchenSectorId?: string | null;
  readonly basePrice: Money;
  /** 0–9999; default 0. */
  readonly sortOrder?: number;
  /** Opcional na criação; default `[]`. Mesmas regras de ReplaceOptionGroupsRequest. */
  readonly optionGroups?: readonly OptionGroupInput[];
}

/** Grupos não são alterados por aqui (use PUT .../option-groups). `status` só por activate/deactivate. */
export interface UpdateProductRequest {
  readonly name?: string;
  readonly description?: string | null;
  readonly code?: string | null;
  readonly categoryId?: string | null;
  readonly kitchenSectorId?: string | null;
  readonly basePrice?: Money;
  readonly sortOrder?: number;
}

export interface ReplaceOptionGroupsRequest {
  /** Até 20 grupos. A ordem da lista vira o `sortOrder` (0, 1, 2...). */
  readonly optionGroups: readonly OptionGroupInput[];
}

export interface OptionGroupInput {
  /** 1–80 caracteres. */
  readonly name: string;
  /** 0–50. */
  readonly minChoices: number;
  /** 1–50, ≥ minChoices e ≤ quantidade de opções. */
  readonly maxChoices: number;
  /** 1–50 opções. A ordem da lista vira o `sortOrder`. */
  readonly options: readonly OptionInput[];
}

export interface OptionInput {
  /** 1–80 caracteres. */
  readonly name: string;
  /** Default `"0.00"`. */
  readonly priceDelta?: Money;
  /**
   * Produto do tenant, ACTIVE, diferente do próprio produto e SEM grupos de opções (combo não aninha combo).
   * Violação -> 409 `linked_product_invalid`; inexistente/de outro tenant -> 404.
   */
  readonly linkedProductId?: string | null;
}

export const PRODUCT_NAME_MAX_LENGTH = 120;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 500;
export const PRODUCT_CATEGORY_NAME_MAX_LENGTH = 80;
export const OPTION_NAME_MAX_LENGTH = 80;
export const OPTION_GROUPS_MAX = 20;
export const OPTIONS_PER_GROUP_MAX = 50;
export const SORT_ORDER_MAX = 9999;

// ── Ajustes por filial ───────────────────────────────────────────────────────────────────────────────────────────

/** Só existe para produtos com ajuste; ausência = disponível com preço base. */
export interface BranchProductSettingDto {
  readonly branchId: string;
  readonly productId: string;
  readonly available: boolean;
  /** Preço nesta filial; `null` = usa o preço base do produto. */
  readonly price: Money | null;
  readonly updatedAt: string;
}

export interface UpsertBranchProductSettingRequest {
  readonly available: boolean;
  /** `null` = usar o preço base. */
  readonly price: Money | null;
}

// ── Cardápio da filial (PDV) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * O que a filial vende AGORA. Inclui só: produtos ACTIVE e disponíveis na filial; categorias ACTIVE com ao menos um
 * produto; opções vinculadas cujo produto esteja ACTIVE e disponível na filial. Produto cujo grupo obrigatório fique
 * sem opções suficientes (`minChoices`) é omitido. Ordem: `sortOrder`, depois criação.
 */
export interface MenuDto {
  readonly branchId: string;
  readonly categories: readonly MenuCategoryDto[];
  /** Todos os produtos vendáveis (com e sem categoria), já ordenados. */
  readonly products: readonly MenuProductDto[];
}

export interface MenuCategoryDto {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface MenuProductDto {
  readonly id: string;
  /** `null` = sem categoria ou categoria inativa. */
  readonly categoryId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly code: string | null;
  /** Preço efetivo nesta filial (ajuste ou base). */
  readonly price: Money;
  readonly optionGroups: readonly ProductOptionGroupDto[];
}
