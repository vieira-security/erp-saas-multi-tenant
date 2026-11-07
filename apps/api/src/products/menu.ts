import type { MenuDto, MenuProductDto, Money, ProductOptionGroupDto } from "@erp/contracts";

/**
 * Montagem do cardápio da filial (`MenuDto`) — função PURA, sem banco: o service carrega tudo em poucas queries e entrega
 * aqui já com dinheiro em `Money` (string). Regras (comentário de `MenuDto` no contrato):
 * - produto entra se ACTIVE (o service só carrega ACTIVE) e disponível na filial (sem ajuste = disponível);
 * - preço = ajuste da filial ou preço base;
 * - opção vinculada (combo) entra só se o produto vinculado também está ACTIVE e disponível na filial;
 * - produto cujo grupo obrigatório fica com menos opções que `minChoices` é omitido;
 * - categoria entra se ACTIVE e com ao menos um produto no cardápio; produto de categoria inativa sai com `categoryId: null`.
 * Defaults técnicos (docs/open-questions.md): grupo opcional que fica sem opções é omitido; `maxChoices` é limitado ao
 * número de opções restantes (mantém `maxChoices ≤ nº de opções` também no cardápio).
 * Ordem determinística: `sortOrder`, depois `createdAt`, depois `id` (comparação de código, nunca collation).
 */

interface Ordered {
  readonly id: string;
  readonly sortOrder: number;
  readonly createdAt: Date;
}

export interface MenuSourceCategory extends Ordered {
  readonly name: string;
}

export interface MenuSourceOption extends Ordered {
  readonly name: string;
  readonly priceDelta: Money;
  readonly linkedProductId: string | null;
}

export interface MenuSourceGroup extends Ordered {
  readonly name: string;
  readonly minChoices: number;
  readonly maxChoices: number;
  readonly options: readonly MenuSourceOption[];
}

export interface MenuSourceProduct extends Ordered {
  readonly categoryId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly code: string | null;
  readonly basePrice: Money;
  readonly optionGroups: readonly MenuSourceGroup[];
}

export interface MenuSourceSetting {
  readonly productId: string;
  readonly available: boolean;
  readonly price: Money | null;
}

export interface MenuSource {
  readonly branchId: string;
  /** Só categorias ACTIVE do tenant. */
  readonly categories: readonly MenuSourceCategory[];
  /** Só produtos ACTIVE do tenant, com grupos e opções. */
  readonly products: readonly MenuSourceProduct[];
  /** Ajustes desta filial. */
  readonly settings: readonly MenuSourceSetting[];
}

export function compareOrdered(a: Ordered, b: Ordered): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const time = a.createdAt.getTime() - b.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sorted<T extends Ordered>(items: readonly T[]): T[] {
  return [...items].sort(compareOrdered);
}

export function buildMenu(source: MenuSource): MenuDto {
  const settings = new Map(source.settings.map((s) => [s.productId, s]));
  const sellable = new Set(source.products.filter((p) => settings.get(p.id)?.available ?? true).map((p) => p.id));
  const activeCategories = new Set(source.categories.map((c) => c.id));

  const products: MenuProductDto[] = [];
  for (const product of sorted(source.products)) {
    if (!sellable.has(product.id)) continue;
    const groups = menuGroups(product.optionGroups, sellable);
    if (groups === null) continue;
    products.push({
      id: product.id,
      categoryId: product.categoryId !== null && activeCategories.has(product.categoryId) ? product.categoryId : null,
      name: product.name,
      description: product.description,
      code: product.code,
      price: settings.get(product.id)?.price ?? product.basePrice,
      optionGroups: groups,
    });
  }

  const used = new Set(products.map((p) => p.categoryId));
  const categories = sorted(source.categories)
    .filter((c) => used.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder }));
  return { branchId: source.branchId, categories, products };
}

/** Grupos do produto no cardápio, ou `null` se algum grupo obrigatório ficou sem opções suficientes. */
function menuGroups(groups: readonly MenuSourceGroup[], sellable: ReadonlySet<string>): ProductOptionGroupDto[] | null {
  const result: ProductOptionGroupDto[] = [];
  for (const group of sorted(groups)) {
    const options = sorted(group.options).filter((o) => o.linkedProductId === null || sellable.has(o.linkedProductId));
    if (options.length < group.minChoices) return null;
    if (options.length === 0) continue;
    result.push({
      id: group.id,
      name: group.name,
      minChoices: group.minChoices,
      maxChoices: Math.min(group.maxChoices, options.length),
      sortOrder: group.sortOrder,
      options: options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, linkedProductId: o.linkedProductId, sortOrder: o.sortOrder })),
    });
  }
  return result;
}
