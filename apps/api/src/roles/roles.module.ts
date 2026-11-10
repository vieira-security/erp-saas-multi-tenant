import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import type { PermissionCode, RoleDto } from "@erp/contracts";
import { sortedPermissionCodes } from "../authorization/effective-permissions.js";
import { RequirePermissions } from "../authorization/permission.guard.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toRoleStatus } from "../users/user.service.js";

/** Comparação por código (UTF-16), independente de locale/collation. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Roles do tenant, somente leitura (contrato `packages/contracts/src/roles.ts`): a tela de funcionários lista as roles
 * para atribuir. Todas, de qualquer status (`ARCHIVED` sai como `INACTIVE`, como em GET /users/:userId). Ordem: roles do
 * sistema primeiro, depois `code`; permissões por código. Uma leitura com as permissões aninhadas, ordenação em memória.
 */
@Injectable()
export class RoleService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  async list(): Promise<RoleDto[]> {
    const rows = await this.prisma.role.findMany({
      where: this.scope.where({}),
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        isSystem: true,
        status: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
    });
    return rows
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || byCode(a.code, b.code) || byCode(a.id, b.id))
      .map((role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        status: toRoleStatus(role.status),
        permissions: sortedPermissionCodes(role.permissions.map((rp) => rp.permission.code)) as PermissionCode[],
      }));
  }
}

@Controller("roles")
export class RolesController {
  constructor(@Inject(RoleService) private readonly roles: RoleService) {}

  @Get()
  @RequirePermissions("role.read")
  list(): Promise<RoleDto[]> {
    return this.roles.list();
  }
}

/** GET /roles (somente leitura). Criar/editar role customizada: fora desta fase. */
@Module({ controllers: [RolesController], providers: [RoleService] })
export class RolesModule {}
