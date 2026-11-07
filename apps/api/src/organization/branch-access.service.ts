import { Inject, Injectable } from "@nestjs/common";
import type { BranchAccessDto } from "@erp/contracts";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PermissionDeniedError } from "../auth/errors.js";
import { AuthorizationService, branchScope } from "../authorization/authorization.service.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { BranchStatus, RoleStatus, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../http/api-error.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { BRANCH_SUMMARY_SELECT, toBranchAccessDto } from "./dto.js";
import { isForeignKeyViolation } from "./prisma-errors.js";

/**
 * UserBranchAccess do tenant atual. A autorização (quem concede/revoga precisa de `user.manage` NA filial alvo, o que já
 * prova que a filial existe no tenant e que o ator tem acesso a ela) é feita pelo PermissionGuard antes de chegar aqui.
 *
 * Além disso (regra "ninguém administra autoridade acima da própria", docs/security.md): o ator só concede/revoga acesso
 * de um usuário cujas roles (todas, de qualquer escopo) não tenham permissão que o próprio ator não tenha naquela filial.
 * Ex.: MANAGER não estende nem remove o acesso de um OWNER. Violação = 403 `forbidden`.
 */
@Injectable()
export class BranchAccessService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
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
    await this.requireNoGreaterAuthority(userId, branchId);
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
    await this.requireNoGreaterAuthority(userId, branchId);
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

  /** 403 se o alvo tiver, em qualquer role ACTIVE, alguma permissão que o ator não tem na filial. */
  private async requireNoGreaterAuthority(targetUserId: string, branchId: string): Promise<void> {
    const actor = await this.authorization.getEffectivePermissions(this.auth.require().userId, branchScope(branchId));
    const target = await this.prisma.rolePermission.findMany({
      where: this.scope.where({ role: { status: RoleStatus.ACTIVE, userRoles: { some: { userId: targetUserId } } } }),
      select: { permission: { select: { code: true } } },
    });
    if (target.some((row) => !actor.has(row.permission.code))) throw new PermissionDeniedError();
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
