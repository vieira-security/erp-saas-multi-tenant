import { Inject, Injectable } from "@nestjs/common";
import type { Money, Page, ProductDto, ProductStatus, ProductSummaryDto } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ProductStatus as DbStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../http/api-error.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { BRANCH_CODE } from "../organization/validation/branch-code.js";
import { isRecordNotFound, isUniqueViolation } from "../organization/prisma-errors.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { PRODUCT_WITH_GROUPS, toProductDto, toProductSummaryDto } from "./dto.js";
import { lockProducts } from "./product-lock.js";
import type { OptionGroupValue } from "./validation.js";

/** Campos já normalizados/validados pelo controller (nome aparado, código em maiúsculo, dinheiro com 2 casas). */
export interface CreateProductInput {
  name: string;
  description?: string | null;
  code?: string | null;
  categoryId?: string | null;
  /** M7: setor do tenant (qualquer status); `null`/ausente = setor padrão. */
  kitchenSectorId?: string | null;
  basePrice: Money;
  sortOrder?: number;
  optionGroups?: readonly OptionGroupValue[];
}

export interface ProductChanges {
  name?: string;
  description?: string | null;
  code?: string | null;
  categoryId?: string | null;
  kitchenSectorId?: string | null;
  basePrice?: Money;
  sortOrder?: number;
}

type Tx = Prisma.TransactionClient;

/**
 * Produtos do tenant atual (TenantScope em toda query; outro tenant = 404). Regras do M4:
 * - `code` único por tenant (409 `product_code_already_exists`, identificado consultando o estado);
 * - `categoryId`: categoria do tenant em qualquer status (senão 404);
 * - `kitchenSectorId` (M7): setor do tenant em qualquer status (inexistente/de outro tenant = 400 `invalid_value`, como o
 *   contrato define); `null` = setor padrão;
 * - grupos/opções substituídos em bloco numa transação;
 * - combo: produto vinculado do tenant (404), ACTIVE, diferente do próprio e sem grupos; produto que já é vinculado não
 *   recebe grupos (409 `linked_product_invalid`). Corrida tratada com trava das linhas de products (product-lock.ts).
 * - desativar não mexe em grupos de outros produtos: o cardápio é que esconde a opção vinculada.
 */
@Injectable()
export class ProductService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  /** Ordem de listagem do contrato (PageQuery): criação crescente, `id` para desempate estável. */
  async list(filter: { categoryId?: string; status?: ProductStatus; q?: string }, page: PageRequest): Promise<Page<ProductSummaryDto>> {
    const where = this.scope.where({
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.q ? { OR: searchFilter(filter.q) } : {}),
    });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: { _count: { select: { optionGroups: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows, total, page, toProductSummaryDto);
  }

  async get(id: string): Promise<ProductDto> {
    return toProductDto(await this.load(this.prisma, id));
  }

  async create(input: CreateProductInput): Promise<ProductDto> {
    const groups = input.optionGroups ?? [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.categoryId) await this.requireCategory(tx, input.categoryId);
        if (input.kitchenSectorId) await this.requireKitchenSector(tx, input.kitchenSectorId);
        await this.checkCombos(tx, null, groups);
        const product = await tx.product.create({
          data: this.scope.data({
            name: input.name,
            description: input.description ?? null,
            code: input.code ?? null,
            categoryId: input.categoryId ?? null,
            kitchenSectorId: input.kitchenSectorId ?? null,
            basePrice: input.basePrice,
            sortOrder: input.sortOrder ?? 0,
            status: DbStatus.ACTIVE,
          }),
        });
        await this.insertGroups(tx, product.id, groups);
        return toProductDto(await this.load(tx, product.id));
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.codeConflict(error, input.code ?? null);
      throw error;
    }
  }

  /** Corpo vazio devolve o registro sem gravar. Grupos e status não mudam por aqui. */
  async update(id: string, changes: ProductChanges): Promise<ProductDto> {
    const { name, description, code, categoryId, kitchenSectorId, basePrice, sortOrder } = changes;
    const data: Prisma.ProductUncheckedUpdateInput = {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(kitchenSectorId !== undefined ? { kitchenSectorId } : {}),
      ...(basePrice !== undefined ? { basePrice } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    };
    if (Object.keys(data).length === 0) return this.get(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // A existência do produto vem antes da categoria: produto de outro tenant é 404 qualquer que seja o corpo.
        const current = await tx.product.findUnique({ where: this.scope.where({ id }), select: { id: true } });
        if (!current) throw new NotFoundError("Product");
        if (categoryId) await this.requireCategory(tx, categoryId);
        if (kitchenSectorId) await this.requireKitchenSector(tx, kitchenSectorId);
        await tx.product.update({ where: this.scope.where({ id }), data });
        return toProductDto(await this.load(tx, id));
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.codeConflict(error, code ?? null, id);
      if (isRecordNotFound(error)) throw new NotFoundError("Product");
      throw error;
    }
  }

  /** Substitui TODOS os grupos/opções (lista vazia remove todos) numa transação, com o produto travado. */
  async replaceOptionGroups(id: string, groups: readonly OptionGroupValue[]): Promise<ProductDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.checkCombos(tx, id, groups);
      await tx.productOption.deleteMany({ where: this.scope.where({ productId: id }) });
      await tx.productOptionGroup.deleteMany({ where: this.scope.where({ productId: id }) });
      await this.insertGroups(tx, id, groups);
      // Os grupos fazem parte do ProductDto: a substituição conta como alteração do produto.
      await tx.product.update({ where: this.scope.where({ id }), data: { updatedAt: new Date() } });
      return toProductDto(await this.load(tx, id));
    });
  }

  /** Idempotente. Não altera grupos de outros produtos que vinculem este (o cardápio filtra). */
  async setStatus(id: string, status: DbStatus): Promise<ProductDto> {
    const product = await this.load(this.prisma, id);
    if (product.status === status) return toProductDto(product);
    try {
      await this.prisma.product.update({ where: this.scope.where({ id }), data: { status } });
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundError("Product");
      throw error;
    }
    return this.get(id);
  }

  private async load(db: Tx | PrismaClient, id: string) {
    const product = await db.product.findUnique({ where: this.scope.where({ id }), include: PRODUCT_WITH_GROUPS });
    if (!product) throw new NotFoundError("Product");
    return product;
  }

  /** Categoria do tenant, em qualquer status. Categorias não são excluídas, e a FK composta garante o resto. */
  private async requireCategory(tx: Tx, categoryId: string): Promise<void> {
    const category = await tx.productCategory.findUnique({ where: this.scope.where({ id: categoryId }), select: { id: true } });
    if (!category) throw new NotFoundError("Product category");
  }

  /**
   * M7: setor do tenant, em qualquer status (setores não são excluídos; a FK composta garante o tenant). Inexistente ou de
   * outro tenant = 400 `invalid_value` em `kitchenSectorId` (contrato), não 404.
   */
  private async requireKitchenSector(tx: Tx, sectorId: string): Promise<void> {
    const sector = await tx.kitchenSector.findUnique({ where: this.scope.where({ id: sectorId }), select: { id: true } });
    if (!sector) throw new ValidationFailedError([{ field: "kitchenSectorId", issue: "invalid_value" }]);
  }

  /**
   * Regras de combo, com as linhas envolvidas travadas (product-lock.ts). `selfId` = produto que recebe os grupos
   * (`null` na criação: ninguém pode vincular um produto que ainda não existe).
   */
  private async checkCombos(tx: Tx, selfId: string | null, groups: readonly OptionGroupValue[]): Promise<void> {
    const linked = [...new Set(groups.flatMap((g) => g.options.flatMap((o) => (o.linkedProductId ? [o.linkedProductId] : []))))];
    const locked = await lockProducts(tx, this.scope.tenantId(), selfId ? [...new Set([selfId, ...linked])] : linked);
    const status = new Map(locked.map((row) => [row.id, row.status]));
    if (selfId && !status.has(selfId)) throw new NotFoundError("Product");
    for (const id of linked) {
      if (!status.has(id)) throw new NotFoundError("Product");
    }
    for (const id of linked) {
      if (id === selfId || status.get(id) !== DbStatus.ACTIVE) throw new ConflictError("linked_product_invalid");
    }
    if (linked.length > 0) {
      // Combo não aninha combo: o produto vinculado não pode ter grupos.
      const nested = await tx.productOptionGroup.count({ where: this.scope.where({ productId: { in: linked } }) });
      if (nested > 0) throw new ConflictError("linked_product_invalid");
    }
    if (selfId && groups.length > 0) {
      // ...nem um produto já vinculado por outro pode passar a ter grupos.
      const linkedBy = await tx.productOption.count({ where: this.scope.where({ linkedProductId: selfId }) });
      if (linkedBy > 0) throw new ConflictError("linked_product_invalid");
    }
  }

  /** Dois comandos no total: grupos (com RETURNING) e todas as opções. A posição na lista vira o `sortOrder`. */
  private async insertGroups(tx: Tx, productId: string, groups: readonly OptionGroupValue[]): Promise<void> {
    if (groups.length === 0) return;
    const created = await tx.productOptionGroup.createManyAndReturn({
      data: groups.map((g, index) =>
        this.scope.data({ productId, name: g.name, minChoices: g.minChoices, maxChoices: g.maxChoices, sortOrder: index }),
      ),
      select: { id: true, sortOrder: true },
    });
    const groupIdAt = new Map(created.map((g) => [g.sortOrder, g.id]));
    await tx.productOption.createMany({
      data: groups.flatMap((g, groupIndex) =>
        g.options.map((o, index) =>
          this.scope.data({
            productId,
            groupId: groupIdAt.get(groupIndex)!,
            name: o.name,
            priceDelta: o.priceDelta,
            linkedProductId: o.linkedProductId,
            sortOrder: index,
          }),
        ),
      ),
    });
  }

  /**
   * Violação de unique -> 409 só se o código está mesmo em uso por outro produto do tenant (consulta o estado, não o
   * `meta` do Prisma). Produtos não são excluídos, então "código livre" significa outra unique: o erro original segue.
   */
  private async codeConflict(error: unknown, code: string | null, exceptId?: string): Promise<unknown> {
    if (!code) return error;
    const taken = await this.prisma.product.count({ where: this.scope.where({ code, ...(exceptId ? { NOT: { id: exceptId } } : {}) }) });
    return taken > 0 ? new ConflictError("product_code_already_exists") : error;
  }
}

/**
 * Busca do contrato: nome contém `q` (sem diferenciar maiúsculas) OU código exatamente igual (normalizado).
 * `contains` vira ILIKE e o Prisma NÃO escapa os curingas: `%`, `_` e `\` do usuário são escapados aqui (o escape padrão
 * do LIKE no PostgreSQL é `\`), senão `q=%` listaria tudo.
 */
function searchFilter(q: string): Prisma.ProductWhereInput[] {
  const code = q.toUpperCase();
  const literal = q.replace(/[\\%_]/g, (char) => `\\${char}`);
  return [{ name: { contains: literal, mode: "insensitive" } }, ...(BRANCH_CODE.test(code) ? [{ code }] : [])];
}
