import { Inject, Injectable } from "@nestjs/common";
import type { ProductCategoryDto, ProductCategoryStatus } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ProductCategoryStatus as DbStatus, type PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { isRecordNotFound } from "../organization/prisma-errors.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toCategoryDto } from "./dto.js";

/**
 * Categorias do tenant atual (TenantScope em toda query; outro tenant = 404). Sem exclusão: só status. Desativar a
 * categoria não mexe nos produtos (no cardápio eles aparecem sem categoria).
 */
@Injectable()
export class CategoryService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  /** Ordem de exibição: `sortOrder`, depois criação (e `id` para desempate estável). */
  async list(filter: { status?: ProductCategoryStatus }): Promise<ProductCategoryDto[]> {
    const rows = await this.prisma.productCategory.findMany({
      where: this.scope.where(filter.status ? { status: filter.status } : {}),
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toCategoryDto);
  }

  async create(input: { name: string; sortOrder?: number }): Promise<ProductCategoryDto> {
    const category = await this.prisma.productCategory.create({
      data: this.scope.data({ name: input.name, sortOrder: input.sortOrder ?? 0, status: DbStatus.ACTIVE }),
    });
    return toCategoryDto(category);
  }

  /** Corpo vazio devolve o registro sem gravar. */
  async update(id: string, changes: { name?: string; sortOrder?: number }): Promise<ProductCategoryDto> {
    const data = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.sortOrder !== undefined ? { sortOrder: changes.sortOrder } : {}),
    };
    if (Object.keys(data).length === 0) return toCategoryDto(await this.find(id));
    return this.write(id, data);
  }

  /** Idempotente. */
  async setStatus(id: string, status: DbStatus): Promise<ProductCategoryDto> {
    const category = await this.find(id);
    if (category.status === status) return toCategoryDto(category);
    return this.write(id, { status });
  }

  private async find(id: string) {
    const category = await this.prisma.productCategory.findUnique({ where: this.scope.where({ id }) });
    if (!category) throw new NotFoundError("Product category");
    return category;
  }

  private async write(id: string, data: { name?: string; sortOrder?: number; status?: DbStatus }): Promise<ProductCategoryDto> {
    try {
      return toCategoryDto(await this.prisma.productCategory.update({ where: this.scope.where({ id }), data }));
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundError("Product category");
      throw error;
    }
  }
}
