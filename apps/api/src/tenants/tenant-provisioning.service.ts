import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { RoleStatus, type PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { DEFAULT_ROLES, DEFAULT_ROLE_PERMISSIONS, type DefaultRoleCode, type RolePermissionMatrix } from "./default-roles.js";

export interface DefaultRolesProvisioning {
  /** Roles padrão criadas nesta execução. */
  readonly created: DefaultRoleCode[];
  /** Roles padrão que já existiam como role de sistema (não alteradas: nome/status podem ter sido ajustados pelo cliente). */
  readonly existing: DefaultRoleCode[];
  /**
   * Código padrão ocupado por uma role CUSTOMIZADA do cliente (`is_system = false`). Não é sequestrada nem recebe
   * permissões; fica para decisão (códigos reservados ainda não foram definidos).
   */
  readonly conflicts: DefaultRoleCode[];
  /** Vínculos RolePermission criados nesta execução. */
  readonly grantsAdded: number;
}

/** Código da matriz que não existe no catálogo global: falha antes de gravar qualquer coisa. */
export class UnknownPermissionInMatrixError extends Error {
  override readonly name = "UnknownPermissionInMatrixError";
  constructor(codes: string[]) {
    super(`Role permission matrix references unknown permissions: ${codes.join(", ")}`);
  }
}

/**
 * Provisionamento idempotente das roles padrão do tenant do contexto (TenantScope). Infraestrutura separada da matriz:
 * `matrix` padrão é `DEFAULT_ROLE_PERMISSIONS`. Numa transação: cria as roles que faltam (`INSERT ... ON CONFLICT DO
 * NOTHING`, seguro sob concorrência) e acrescenta os vínculos da matriz que faltam. Nunca remove role/vínculo, nunca altera
 * role existente e nunca toca role customizada que use um código padrão. Roda como `erp_app` (só INSERT/SELECT já
 * concedidos): nenhum privilégio novo.
 */
@Injectable()
export class TenantProvisioningService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  async provisionDefaultRoles(matrix: RolePermissionMatrix = DEFAULT_ROLE_PERMISSIONS): Promise<DefaultRolesProvisioning> {
    const codes = DEFAULT_ROLES.map((r) => r.code);
    return this.prisma.$transaction(async (tx) => {
      const wanted = [...new Set(codes.flatMap((code) => matrix[code]))];
      const permissions = wanted.length
        ? await tx.permission.findMany({ where: { code: { in: wanted } }, select: { id: true, code: true } })
        : [];
      const missing = wanted.filter((code) => !permissions.some((p) => p.code === code));
      if (missing.length) throw new UnknownPermissionInMatrixError(missing);

      // ON CONFLICT DO NOTHING RETURNING: só as linhas que ESTA transação inseriu (concorrentes esperam e não reinserem).
      const inserted = await tx.role.createManyAndReturn({
        data: DEFAULT_ROLES.map(({ code, name }) => this.scope.data({ code, name, isSystem: true, status: RoleStatus.ACTIVE })),
        skipDuplicates: true,
        select: { code: true },
      });
      const roles = await tx.role.findMany({ where: this.scope.where({ code: { in: codes } }), select: { id: true, code: true, isSystem: true } });

      const created: DefaultRoleCode[] = [];
      const existing: DefaultRoleCode[] = [];
      const conflicts: DefaultRoleCode[] = [];
      const grants: { roleId: string; permissionId: string }[] = [];
      for (const code of codes) {
        const role = roles.find((r) => r.code === code);
        if (!role) throw new Error(`Default role ${code} was not provisioned`);
        if (!role.isSystem) {
          conflicts.push(code);
          continue;
        }
        (inserted.some((r) => r.code === code) ? created : existing).push(code);
        for (const permissionCode of matrix[code]) {
          grants.push({ roleId: role.id, permissionId: permissions.find((p) => p.code === permissionCode)!.id });
        }
      }

      const { count } = grants.length
        ? await tx.rolePermission.createMany({ data: grants.map((g) => this.scope.data(g)), skipDuplicates: true })
        : { count: 0 };
      return { created, existing, conflicts, grantsAdded: count };
    });
  }
}
