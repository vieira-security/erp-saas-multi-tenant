import { Inject, Injectable } from "@nestjs/common";
import type { ProductCategoryDto, ProductCategoryStatus } from "@erp/contracts";
import { lockRowForAudit } from "../audit/audit-lock.js";
import { BusinessAuditWriter, auditActorOf } from "../audit/business-audit.js";
import { diffChanges } from "../audit/changes.js";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ProductCategoryStatus as DbStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toCategoryDto } from "./dto.js";

/**
 * Categorias do tenant atual (TenantScope em toda query; outro tenant = 404). Sem exclusão: só status. Desativar a
 * categoria não mexe nos produtos (no cardápio eles aparecem sem categoria).
 * KAN-41: `product_category.*` (eventos do tenant) na mesma transação; sem mudança não audita.
 */
@Injectable()
export class CategoryService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
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
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.productCategory.create({
        data: this.scope.data({ name: input.name, sortOrder: input.sortOrder ?? 0, status: DbStatus.ACTIVE }),
      });
      await new BusinessAuditWriter(tx, this.scope).record(actor, {
        action: "product_category.created",
        categoryId: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
      });
      return toCategoryDto(category);
    });
  }

  /** Corpo vazio devolve o registro sem gravar. Valores iguais aos atuais gravam, mas não auditam (nada mudou). */
  async update(id: string, changes: { name?: string; sortOrder?: number }): Promise<ProductCategoryDto> {
    const data = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.sortOrder !== undefined ? { sortOrder: changes.sortOrder } : {}),
    };
    if (Object.keys(data).length === 0) return toCategoryDto(await this.find(id));
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockAndFind(tx, id);
      const category = await tx.productCategory.update({ where: this.scope.where({ id }), data });
      await new BusinessAuditWriter(tx, this.scope).record(actor, {
        action: "product_category.updated",
        categoryId: id,
        changes: diffChanges(before, data, ["name", "sortOrder"]),
      });
      return toCategoryDto(category);
    });
  }

  /** Idempotente: já no status pedido = sem gravação nem auditoria. */
  async setStatus(id: string, status: DbStatus): Promise<ProductCategoryDto> {
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      const category = await this.lockAndFind(tx, id);
      if (category.status === status) return toCategoryDto(category);
      const updated = await tx.productCategory.update({ where: this.scope.where({ id }), data: { status } });
      await new BusinessAuditWriter(tx, this.scope).record(actor, {
        action: status === DbStatus.ACTIVE ? "product_category.activated" : "product_category.deactivated",
        categoryId: id,
      });
      return toCategoryDto(updated);
    });
  }

  private async find(id: string) {
    const category = await this.prisma.productCategory.findUnique({ where: this.scope.where({ id }) });
    if (!category) throw new NotFoundError("Product category");
    return category;
  }

  /** Linha travada FOR UPDATE e lida em seguida: o "antes" da auditoria é o estado real da alteração. */
  private async lockAndFind(tx: Prisma.TransactionClient, id: string) {
    if (!(await lockRowForAudit(tx, "product_categories", this.scope.tenantId(), id))) throw new NotFoundError("Product category");
    return tx.productCategory.findUniqueOrThrow({ where: this.scope.where({ id }) });
  }
}
