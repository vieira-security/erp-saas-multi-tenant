import { Inject, Injectable } from "@nestjs/common";
import type { BranchProductSettingDto, MenuDto, Money } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ProductCategoryStatus, ProductStatus, type PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { toMoney } from "../http/money.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toBranchProductSettingDto } from "./dto.js";
import { buildMenu } from "./menu.js";

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
  ) {}

  async listSettings(branchId: string): Promise<BranchProductSettingDto[]> {
    const rows = await this.prisma.branchProductSetting.findMany({
      where: this.scope.where({ branchId }),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toBranchProductSettingDto);
  }

  /**
   * Upsert idempotente: repetir o mesmo PUT não regrava (nem muda `updatedAt`). Seguro em paralelo: UPDATE, senão
   * INSERT ... ON CONFLICT DO NOTHING, e UPDATE de novo se outro request inseriu primeiro.
   */
  async upsert(branchId: string, productId: string, input: { available: boolean; price: Money | null }): Promise<BranchProductSettingDto> {
    const product = await this.prisma.product.findUnique({ where: this.scope.where({ id: productId }), select: { id: true } });
    if (!product) throw new NotFoundError("Product");
    const where = this.scope.where({ branchId, productId });
    const data = { available: input.available, price: input.price };
    const current = await this.prisma.branchProductSetting.findFirst({ where });
    if (current && current.available === input.available && (current.price === null ? null : toMoney(current.price)) === input.price) {
      return toBranchProductSettingDto(current);
    }
    if (!current || (await this.prisma.branchProductSetting.updateMany({ where, data })).count === 0) {
      const inserted = await this.prisma.branchProductSetting.createMany({ data: [this.scope.data({ branchId, productId, ...data })], skipDuplicates: true });
      if (inserted.count === 0) await this.prisma.branchProductSetting.updateMany({ where, data });
    }
    const setting = await this.prisma.branchProductSetting.findFirst({ where });
    if (!setting) throw new NotFoundError("Branch product setting");
    return toBranchProductSettingDto(setting);
  }

  /** Volta ao padrão (disponível, preço base). Idempotente: sem ajuste também é sucesso. */
  async remove(branchId: string, productId: string): Promise<void> {
    await this.prisma.branchProductSetting.deleteMany({ where: this.scope.where({ branchId, productId }) });
  }

  /** Quatro leituras (categorias, produtos+grupos+opções em lote pelo Prisma, ajustes) e montagem em memória (menu.ts). */
  async menu(branchId: string): Promise<MenuDto> {
    const [categories, products, settings] = await this.prisma.$transaction([
      this.prisma.productCategory.findMany({
        where: this.scope.where({ status: ProductCategoryStatus.ACTIVE }),
        select: { id: true, name: true, sortOrder: true, createdAt: true },
      }),
      this.prisma.product.findMany({
        where: this.scope.where({ status: ProductStatus.ACTIVE }),
        include: { optionGroups: { include: { options: true } } },
      }),
      this.prisma.branchProductSetting.findMany({
        where: this.scope.where({ branchId }),
        select: { productId: true, available: true, price: true },
      }),
    ]);
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
