import { Inject, Injectable } from "@nestjs/common";
import type { MeBranchDto, MeDto, PermissionCode } from "@erp/contracts";
import { AuthContextService } from "../auth/context/auth-context.js";
import { UnauthenticatedError } from "../auth/errors.js";
import { TENANT_SCOPE, branchScope } from "../authorization/authorization.service.js";
import { resolveEffectivePermissions, sortedPermissionCodes, type RoleAssignment } from "../authorization/effective-permissions.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { BranchStatus, CompanyStatus, RoleStatus, UserStatus, type PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";

/**
 * GET /me (KAN-52): quem é o usuário autenticado, a organização do token e as permissões efetivas no tenant e em cada
 * filial com acesso. Tudo do AuthContext/TenantContext (nunca de parâmetro); `tenantId` nunca sai.
 *
 * Quatro leituras numa transação de leitura (tenant, usuário, acessos às filiais, atribuições de role ACTIVE com as
 * permissões) e resolução em memória com a MESMA regra do AuthorizationService (`resolveEffectivePermissions`), sem uma
 * query por filial. A interface usa isto para montar menus; cada rota continua conferindo a permissão (403).
 */
@Injectable()
export class MeService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  async get(): Promise<MeDto> {
    const { userId } = this.auth.require();
    const [tenant, user, accesses, assignments] = await this.prisma.$transaction([
      this.prisma.tenant.findUnique({ where: { id: this.scope.tenantId() }, select: { id: true, name: true, status: true, loginCode: true } }),
      this.prisma.user.findUnique({
        where: this.scope.where({ id: userId }),
        select: { id: true, name: true, employeeNumber: true, mustChangePassword: true, status: true },
      }),
      this.prisma.userBranchAccess.findMany({
        where: this.scope.where({ userId }),
        select: { branch: { select: { id: true, companyId: true, name: true, code: true, status: true, company: { select: { status: true } } } } },
        orderBy: [{ branch: { createdAt: "asc" } }, { branchId: "asc" }],
      }),
      this.prisma.userRole.findMany({
        where: this.scope.where({ userId, role: { status: RoleStatus.ACTIVE } }),
        select: { branchId: true, role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } },
      }),
    ]);
    // A sessão foi validada pelo AuthGuard; usuário/tenant sumirem no meio da requisição = não autenticado.
    if (!tenant || !user) throw new UnauthenticatedError("user_not_found");

    // Mesma regra do AuthorizationService: só usuário ACTIVE tem permissão.
    const roles: RoleAssignment[] =
      user.status === UserStatus.ACTIVE
        ? assignments.map((a) => ({ branchId: a.branchId, permissions: a.role.permissions.map((rp) => rp.permission.code) }))
        : [];
    const accessible = new Set(accesses.map((a) => a.branch.id));
    const codes = (permissions: ReadonlySet<string>) => sortedPermissionCodes(permissions) as PermissionCode[];

    const branches: MeBranchDto[] = accesses.map(({ branch }) => ({
      id: branch.id,
      companyId: branch.companyId,
      name: branch.name,
      code: branch.code,
      status: branch.status,
      operable: branch.status === BranchStatus.ACTIVE && branch.company.status === CompanyStatus.ACTIVE,
      permissions: codes(resolveEffectivePermissions(roles, branchScope(branch.id), accessible)),
    }));

    return {
      user: { id: user.id, name: user.name, employeeNumber: user.employeeNumber, mustChangePassword: user.mustChangePassword },
      organization: { id: tenant.id, name: tenant.name, status: tenant.status, loginCode: tenant.loginCode },
      permissions: codes(resolveEffectivePermissions(roles, TENANT_SCOPE, accessible)),
      branches,
    };
  }
}
