import { Inject, Injectable } from "@nestjs/common";
import type { BranchAccessDto } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { BranchStatus, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../http/api-error.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { BRANCH_SUMMARY_SELECT, toBranchAccessDto } from "./dto.js";
import { isForeignKeyViolation } from "./prisma-errors.js";

/**
 * UserBranchAccess do tenant atual. A autorização (quem concede/revoga precisa de `user.manage` NA filial alvo, o que já
 * prova que a filial existe no tenant e que o ator tem acesso a ela) é feita pelo PermissionGuard antes de chegar aqui.
 */
@Injectable()
export class BranchAccessService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  async list(userId: string): Promise<BranchAccessDto[]> {
    await this.requireUser(userId);
    const rows = await this.prisma.userBranchAccess.findMany({
      where: this.scope.where({ userId }),
      select: { userId: true, branchId: true, createdAt: true, branch: { select: BRANCH_SUMMARY_SELECT } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toBranchAccessDto);
  }

  /** Idempotente: `created = false` quando o acesso já existia. Só filial ACTIVE recebe acesso novo. */
  async grant(userId: string, branchId: string): Promise<{ created: boolean; access: BranchAccessDto }> {
    await this.requireUser(userId);
    const branch = await this.prisma.branch.findUnique({ where: this.scope.where({ id: branchId }), select: { status: true } });
    if (!branch) throw new NotFoundError("Branch");
    const existing = await this.find(userId, branchId);
    if (existing) return { created: false, access: existing };
    if (branch.status !== BranchStatus.ACTIVE) throw new ConflictError("branch_inactive");
    // ON CONFLICT DO NOTHING: duas concessões simultâneas não falham; só uma insere.
    const inserted = await this.prisma.userBranchAccess.createMany({ data: [this.scope.data({ userId, branchId })], skipDuplicates: true });
    const access = await this.find(userId, branchId);
    if (!access) throw new NotFoundError("Branch access");
    return { created: inserted.count === 1, access };
  }

  /** 404 se o acesso não existir; 409 se o usuário ainda tiver role escopada a essa filial (FK `RESTRICT`). */
  async revoke(userId: string, branchId: string): Promise<void> {
    await this.requireUser(userId);
    const scopedRoles = await this.prisma.userRole.count({ where: this.scope.where({ userId, branchId }) });
    if (scopedRoles > 0) throw new ConflictError("branch_access_in_use");
    try {
      const deleted = await this.prisma.userBranchAccess.deleteMany({ where: this.scope.where({ userId, branchId }) });
      if (deleted.count === 0) throw new NotFoundError("Branch access");
    } catch (error) {
      // Corrida: role escopada criada entre a contagem e o DELETE.
      if (isForeignKeyViolation(error)) throw new ConflictError("branch_access_in_use");
      throw error;
    }
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: this.scope.where({ id: userId }), select: { id: true } });
    if (!user) throw new NotFoundError("User");
  }

  private async find(userId: string, branchId: string): Promise<BranchAccessDto | null> {
    const row = await this.prisma.userBranchAccess.findFirst({
      where: this.scope.where({ userId, branchId }),
      select: { userId: true, branchId: true, createdAt: true, branch: { select: BRANCH_SUMMARY_SELECT } },
    });
    return row ? toBranchAccessDto(row) : null;
  }
}
