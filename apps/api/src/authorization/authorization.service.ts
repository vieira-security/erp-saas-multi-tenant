import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { RoleStatus, UserStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";

/**
 * Escopo em que a permissão é avaliada. NUNCA vem direto do cliente: `branch` só deve ser construído com um `branchId`
 * já resolvido a partir do recurso (ex.: a filial do pedido, validada no tenant) ou de API interna confiável.
 * - `tenant`: só roles tenant-wide (`user_roles.branch_id IS NULL`). Role escopada a filial NÃO vira permissão global.
 * - `branch`: roles tenant-wide + roles daquela filial.
 */
export type AuthorizationScope = { readonly kind: "tenant" } | { readonly kind: "branch"; readonly branchId: string };

export const TENANT_SCOPE: AuthorizationScope = Object.freeze({ kind: "tenant" });

export function branchScope(branchId: string): AuthorizationScope {
  return Object.freeze({ kind: "branch", branchId });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Permissões efetivas, resolvidas no backend a cada chamada (sem cache permanente, nada no JWT). Regras:
 * - só usuário `ACTIVE` tem permissão (DISABLED/LOCKED = nenhuma);
 * - só role `ACTIVE` concede (INACTIVE/ARCHIVED = nada);
 * - tudo no tenant do TenantContext (TenantScope); vínculos de outro tenant são impossíveis pelas FKs compostas e,
 *   mesmo assim, a query filtra `tenant_id`;
 * - escopo de filial conforme `AuthorizationScope`; filial inexistente no tenant = nenhuma permissão.
 * Uma única query (RolePermission ⨝ Role ⨝ UserRole ⨝ User ⨝ Permission), sem N+1. Nomes de role nunca são usados.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  async getEffectivePermissions(userId: string, scope: AuthorizationScope = TENANT_SCOPE): Promise<ReadonlySet<string>> {
    if (!UUID.test(userId)) return new Set();
    if (scope.kind === "branch" && !(await this.branchExists(scope.branchId))) return new Set();

    const assignment: Prisma.UserRoleWhereInput = {
      userId,
      user: { status: UserStatus.ACTIVE },
      ...(scope.kind === "branch" ? { OR: [{ branchId: null }, { branchId: scope.branchId }] } : { branchId: null }),
    };
    const rows = await this.prisma.rolePermission.findMany({
      where: this.scope.where({ role: { status: RoleStatus.ACTIVE, userRoles: { some: assignment } } }),
      select: { permission: { select: { code: true } } },
    });
    return new Set(rows.map((row) => row.permission.code));
  }

  async hasPermission(userId: string, permission: string, scope?: AuthorizationScope): Promise<boolean> {
    return (await this.getEffectivePermissions(userId, scope)).has(permission);
  }

  /** `true` para lista vazia (nada exigido). */
  async hasAllPermissions(userId: string, permissions: readonly string[], scope?: AuthorizationScope): Promise<boolean> {
    if (permissions.length === 0) return true;
    const effective = await this.getEffectivePermissions(userId, scope);
    return permissions.every((p) => effective.has(p));
  }

  /** `false` para lista vazia. */
  async hasAnyPermission(userId: string, permissions: readonly string[], scope?: AuthorizationScope): Promise<boolean> {
    if (permissions.length === 0) return false;
    const effective = await this.getEffectivePermissions(userId, scope);
    return permissions.some((p) => effective.has(p));
  }

  private async branchExists(branchId: string): Promise<boolean> {
    if (!UUID.test(branchId)) return false;
    return (await this.prisma.branch.count({ where: this.scope.where({ id: branchId }) })) === 1;
  }
}
