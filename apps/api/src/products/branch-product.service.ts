import { Inject, Injectable } from "@nestjs/common";
import type { BranchProductSettingDto, MenuDto, Money } from "@erp/contracts";
import { BusinessAuditWriter, auditActorOf, type AuditActor } from "../audit/business-audit.js";
import { diffChanges } from "../audit/changes.js";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ProductCategoryStatus, ProductStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { toMoney } from "../http/money.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toBranchProductSettingDto } from "./dto.js";
import { buildMenu } from "./menu.js";

/** Sem ajuste na filial = disponível, com o preço base (`price` null). */
const DEFAULT_SETTING = Object.freeze({ available: true, price: null });

/**
 * Ajustes de produto por filial e cardápio da filial. O acesso à filial (que também prova que ela existe no tenant) é
 * verificado pelo PermissionGuard (`@RequireBranchPermissions`) antes de chegar aqui; mesmo assim toda query leva o
 * TenantScope, e a FK composta (tenant_id, branch_id) impede gravar ajuste em filial de outro tenant.
 */
@Injectable()
export class BranchProductService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  async listSettings(branchId: string): Promise<BranchProductSettingDto[]> {
    const rows = await this.prisma.branchProductSetting.findMany({
      where: this.scope.where({ branchId }),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toBranchProductSettingDto);
  }

  /**
   * Upsert idempotente: repetir o mesmo PUT não regrava (nem muda `updatedAt`) nem audita. Seguro em paralelo: o ajuste
   * existente fica travado FOR UPDATE; sem ajuste, INSERT ... ON CONFLICT DO NOTHING, e se outro request inseriu primeiro,
   * trava a linha dele e atualiza. KAN-41: `branch_product_setting.updated` (filial = a da rota) com o antes/depois de
   * `available`/`price` (sem ajuste = padrão: disponível, preço base), na mesma transação.
   */
  async upsert(branchId: string, productId: string, input: { available: boolean; price: Money | null }): Promise<BranchProductSettingDto> {
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: this.scope.where({ id: productId }), select: { id: true } });
      if (!product) throw new NotFoundError("Product");
      const where = this.scope.where({ branchId, productId });
      const data = { available: input.available, price: input.price };
      let current = await this.lockSetting(tx, branchId, productId);
      if (!current) {
        const inserted = await tx.branchProductSetting.createMany({ data: [this.scope.data({ branchId, productId, ...data })], skipDuplicates: true });
        if (inserted.count === 1) {
          await this.audit(tx, actor, branchId, productId, DEFAULT_SETTING, data);
          return toBranchProductSettingDto((await tx.branchProductSetting.findFirst({ where }))!);
        }
        current = await this.lockSetting(tx, branchId, productId);
        if (!current) throw new NotFoundError("Branch product setting");
      }
      if (current.available === input.available && (current.price === null ? null : toMoney(current.price)) === input.price) {
        return toBranchProductSettingDto(current);
      }
      await tx.branchProductSetting.updateMany({ where, data });
      await this.audit(tx, actor, branchId, productId, current, data);
      const setting = await tx.branchProductSetting.findFirst({ where });
      if (!setting) throw new NotFoundError("Branch product setting");
      return toBranchProductSettingDto(setting);
    });
  }

  /** Volta ao padrão (disponível, preço base). Idempotente: sem ajuste também é sucesso (e não audita). */
  async remove(branchId: string, productId: string): Promise<void> {
    const actor = auditActorOf(this.auth);
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockSetting(tx, branchId, productId);
      if (!current) return;
      await tx.branchProductSetting.deleteMany({ where: this.scope.where({ branchId, productId }) });
      await this.audit(tx, actor, branchId, productId, current, DEFAULT_SETTING);
    });
  }

  /** Ajuste desta filial travado FOR UPDATE (ou `null` se não existe). */
  private async lockSetting(tx: Prisma.TransactionClient, branchId: string, productId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM branch_product_settings
      WHERE tenant_id = ${this.scope.tenantId()}::uuid AND branch_id = ${branchId}::uuid AND product_id = ${productId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) return null;
    return tx.branchProductSetting.findFirst({ where: this.scope.where({ branchId, productId }) });
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: AuditActor | null,
    branchId: string,
    productId: string,
    before: { available: boolean; price: unknown },
    after: { available: boolean; price: Money | null },
  ): Promise<void> {
    await new BusinessAuditWriter(tx, this.scope).record(actor, {
      action: "branch_product_setting.updated",
      branchId,
      productId,
      changes: diffChanges(before, after, ["available", "price"]),
    });
  }

  /**
   * Quatro leituras (categorias, produtos+grupos+opções em lote pelo Prisma, ajustes) e montagem em memória (menu.ts).
   * `db` = transação de quem chama (M5: pedidos validam e precificam itens com ESTE cardápio dentro da própria
   * transação); sem ela, as leituras rodam juntas num batch.
   */
  async menu(branchId: string, db?: Prisma.TransactionClient): Promise<MenuDto> {
    const client = db ?? this.prisma;
    const queries = [
      client.productCategory.findMany({
        where: this.scope.where({ status: ProductCategoryStatus.ACTIVE }),
        select: { id: true, name: true, sortOrder: true, createdAt: true },
      }),
      client.product.findMany({
        where: this.scope.where({ status: ProductStatus.ACTIVE }),
        include: { optionGroups: { include: { options: true } } },
      }),
      client.branchProductSetting.findMany({
        where: this.scope.where({ branchId }),
        select: { productId: true, available: true, price: true },
      }),
    ] as const;
    const [categories, products, settings] = db ? await Promise.all(queries) : await this.prisma.$transaction([...queries]);
    return buildMenu({
      branchId,
      categories,
      settings: settings.map((s) => ({ productId: s.productId, available: s.available, price: s.price === null ? null : toMoney(s.price) })),
      products: products.map((p) => ({
        id: p.id,
        categoryId: p.categoryId,
        name: p.name,
        description: p.description,
        code: p.code,
        basePrice: toMoney(p.basePrice),
        sortOrder: p.sortOrder,
        createdAt: p.createdAt,
        optionGroups: p.optionGroups.map((g) => ({
          id: g.id,
          name: g.name,
          minChoices: g.minChoices,
          maxChoices: g.maxChoices,
          sortOrder: g.sortOrder,
          createdAt: g.createdAt,
          options: g.options.map((o) => ({
            id: o.id,
            name: o.name,
            priceDelta: toMoney(o.priceDelta),
            linkedProductId: o.linkedProductId,
            sortOrder: o.sortOrder,
            createdAt: o.createdAt,
          })),
        })),
      })),
    });
  }
}
