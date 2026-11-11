import { Inject, Injectable } from "@nestjs/common";
import type { BranchKitchenSectorDto, KitchenSectorDto } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { uuidV7 } from "../database/uuid-v7.js";
import { KitchenSectorStatus as DbStatus, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../http/api-error.js";
import { isRecordNotFound, isUniqueViolation } from "../organization/prisma-errors.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toBranchKitchenSectorDto, toKitchenSectorDto } from "./dto.js";
import { lockAllSectors, lockSector } from "./kitchen-lock.js";
import { compareSectors } from "./kitchen-rules.js";

export interface CreateKitchenSectorInput {
  name: string;
  code: string;
  sortOrder?: number;
}

export interface KitchenSectorChanges {
  name?: string;
  code?: string;
  sortOrder?: number;
}

/**
 * Setores de preparo do tenant atual (TenantScope em toda query; outro tenant = 404) e o liga/desliga por filial.
 * - código único no tenant (409 `kitchen_sector_code_already_exists`, identificado consultando o estado, inclusive na
 *   corrida entre dois cadastros);
 * - sem exclusão: só status; o padrão não é desativado (409 `kitchen_sector_default_required`) nem desligado em filial;
 * - `make-default` troca o padrão atomicamente (trava todos os setores do tenant, desmarca o antigo, marca o novo); setor
 *   INACTIVE não vira padrão (409 `kitchen_sector_inactive`). Ativar/desativar/tornar padrão são idempotentes.
 * Ordem de travas e interação com a confirmação: kitchen-lock.ts.
 */
@Injectable()
export class KitchenSectorService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  /** Padrão primeiro, depois `sortOrder`, `name` por código (sem collation) e `id`. */
  async list(): Promise<KitchenSectorDto[]> {
    const rows = await this.prisma.kitchenSector.findMany({ where: this.scope.where({}) });
    return rows.sort(compareSectors).map(toKitchenSectorDto);
  }

  async create(input: CreateKitchenSectorInput): Promise<KitchenSectorDto> {
    try {
      const sector = await this.prisma.kitchenSector.create({
        data: this.scope.data({ name: input.name, code: input.code, sortOrder: input.sortOrder ?? 0, isDefault: false, status: DbStatus.ACTIVE }),
      });
      return toKitchenSectorDto(sector);
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.codeConflict(error, input.code);
      throw error;
    }
  }

  /** Corpo vazio devolve o registro sem gravar (mesma convenção das demais PATCH do repo). Status e padrão não mudam aqui. */
  async update(id: string, changes: KitchenSectorChanges): Promise<KitchenSectorDto> {
    const data = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.code !== undefined ? { code: changes.code } : {}),
      ...(changes.sortOrder !== undefined ? { sortOrder: changes.sortOrder } : {}),
    };
    if (Object.keys(data).length === 0) return toKitchenSectorDto(await this.find(id));
    try {
      return toKitchenSectorDto(await this.prisma.kitchenSector.update({ where: this.scope.where({ id }), data }));
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundError("Kitchen sector");
      if (isUniqueViolation(error)) throw await this.codeConflict(error, changes.code ?? null, id);
      throw error;
    }
  }

  /** Troca o padrão: todos os setores do tenant travados (por `id`); desmarca o antigo ANTES de marcar o novo (índice único parcial). */
  async makeDefault(id: string): Promise<KitchenSectorDto> {
    return this.prisma.$transaction(async (tx) => {
      const sectors = await lockAllSectors(tx, this.scope.tenantId());
      const target = sectors.find((s) => s.id === id);
      if (!target) throw new NotFoundError("Kitchen sector");
      if (!target.isDefault) {
        if (target.status !== DbStatus.ACTIVE) throw new ConflictError("kitchen_sector_inactive");
        await tx.kitchenSector.updateMany({ where: this.scope.where({ isDefault: true }), data: { isDefault: false } });
        await tx.kitchenSector.update({ where: this.scope.where({ id }), data: { isDefault: true } });
      }
      return toKitchenSectorDto(await tx.kitchenSector.findUniqueOrThrow({ where: this.scope.where({ id }) }));
    });
  }

  /** Idempotente. Desativar o padrão = 409 (o padrão também é sempre ACTIVE pelo CHECK do banco). */
  async setStatus(id: string, status: DbStatus): Promise<KitchenSectorDto> {
    return this.prisma.$transaction(async (tx) => {
      const sector = await lockSector(tx, this.scope.tenantId(), id);
      if (!sector) throw new NotFoundError("Kitchen sector");
      if (sector.status !== status) {
        if (status === DbStatus.INACTIVE && sector.isDefault) throw new ConflictError("kitchen_sector_default_required");
        await tx.kitchenSector.update({ where: this.scope.where({ id }), data: { status } });
      }
      return toKitchenSectorDto(await tx.kitchenSector.findUniqueOrThrow({ where: this.scope.where({ id }) }));
    });
  }

  /** Todos os setores do tenant com o ajuste desta filial (o acesso à filial já foi exigido pelo PermissionGuard). */
  async listForBranch(branchId: string): Promise<BranchKitchenSectorDto[]> {
    const [sectors, settings] = await this.prisma.$transaction([
      this.prisma.kitchenSector.findMany({ where: this.scope.where({}) }),
      this.prisma.branchKitchenSector.findMany({ where: this.scope.where({ branchId }), select: { sectorId: true, enabled: true } }),
    ]);
    const stored = new Map(settings.map((s) => [s.sectorId, s]));
    return sectors.sort(compareSectors).map((s) => toBranchKitchenSectorDto(s, stored.get(s.id)));
  }

  /**
   * Liga/desliga o setor na filial. O setor fica travado FOR UPDATE: serializa com a confirmação (que lê os setores FOR
   * SHARE) e com a troca do padrão. Desligar o padrão = 409. Upsert idempotente (sem mudança não regrava).
   */
  async setForBranch(branchId: string, sectorId: string, enabled: boolean): Promise<BranchKitchenSectorDto> {
    return this.prisma.$transaction(async (tx) => {
      const tenantId = this.scope.tenantId();
      const locked = await lockSector(tx, tenantId, sectorId);
      if (!locked) throw new NotFoundError("Kitchen sector");
      if (locked.isDefault && !enabled) throw new ConflictError("kitchen_sector_default_required");
      await tx.$executeRaw`
        INSERT INTO branch_kitchen_sectors (id, tenant_id, branch_id, sector_id, enabled, created_at, updated_at)
        VALUES (${uuidV7()}::uuid, ${tenantId}::uuid, ${branchId}::uuid, ${sectorId}::uuid, ${enabled}, now(), now())
        ON CONFLICT (tenant_id, branch_id, sector_id)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
        WHERE branch_kitchen_sectors.enabled IS DISTINCT FROM EXCLUDED.enabled`;
      const sector = await tx.kitchenSector.findUniqueOrThrow({ where: this.scope.where({ id: sectorId }) });
      const setting = await tx.branchKitchenSector.findFirst({ where: this.scope.where({ branchId, sectorId }), select: { enabled: true } });
      return toBranchKitchenSectorDto(sector, setting ?? undefined);
    });
  }

  private async find(id: string) {
    const sector = await this.prisma.kitchenSector.findUnique({ where: this.scope.where({ id }) });
    if (!sector) throw new NotFoundError("Kitchen sector");
    return sector;
  }

  /** Violação de unique -> 409 só se o código está mesmo em uso por outro setor do tenant; senão o erro original segue. */
  private async codeConflict(error: unknown, code: string | null, exceptId?: string): Promise<unknown> {
    if (!code) return error;
    const taken = await this.prisma.kitchenSector.count({ where: this.scope.where({ code, ...(exceptId ? { NOT: { id: exceptId } } : {}) }) });
    return taken > 0 ? new ConflictError("kitchen_sector_code_already_exists") : error;
  }
}
