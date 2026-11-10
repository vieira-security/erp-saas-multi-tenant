import { Inject, Injectable } from "@nestjs/common";
import { PermissionDeniedError } from "../auth/errors.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { RoleStatus, type PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { AuthorizationService, TENANT_SCOPE, branchScope, type AuthorizationScope } from "./authorization.service.js";

/**
 * Regra "ninguém administra autoridade acima da própria" (docs/security.md), num lugar só. Compara CÓDIGOS de
 * permissão, nunca nomes de role.
 */

/** `true` se `required` tem alguma permissão fora de `actor`. */
export function exceedsAuthority(actor: ReadonlySet<string>, required: Iterable<string>): boolean {
  for (const code of required) if (!actor.has(code)) return true;
  return false;
}

/** Uma atribuição de role que entra ou sai, com as permissões da role (qualquer status da role). */
export interface RoleChange {
  readonly roleId: string;
  /** `null` = tenant inteiro. */
  readonly branchId: string | null;
  readonly permissions: readonly string[];
}

/**
 * Atribuições que o ator NÃO pode mexer: a role precisa ter só permissões que o ator tem no escopo da atribuição
 * (tenant para `branchId = null`, a filial caso contrário). `actorPermissions` devolve as permissões efetivas do ator
 * naquele escopo.
 */
export function forbiddenRoleChanges(
  changes: readonly RoleChange[],
  actorPermissions: (branchId: string | null) => ReadonlySet<string>,
): RoleChange[] {
  return changes.filter((change) => exceedsAuthority(actorPermissions(change.branchId), change.permissions));
}

@Injectable()
export class AuthorityService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  /** Permissões de TODAS as roles ACTIVE do usuário, em qualquer escopo (tenant ou filial). */
  async permissionsHeldAnywhere(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.rolePermission.findMany({
      where: this.scope.where({ role: { status: RoleStatus.ACTIVE, userRoles: { some: { userId } } } }),
      select: { permission: { select: { code: true } } },
    });
    return new Set(rows.map((row) => row.permission.code));
  }

  /**
   * 403 se o alvo tiver, em qualquer role ACTIVE de qualquer escopo, permissão que o ator não tem em `actorScope`.
   * Gestão de funcionários: escopo do tenant. Acesso a filial (M3): a filial alvo.
   */
  async requireNoGreaterAuthority(actorUserId: string, targetUserId: string, actorScope: AuthorizationScope = TENANT_SCOPE): Promise<void> {
    const [actor, target] = await Promise.all([
      this.authorization.getEffectivePermissions(actorUserId, actorScope),
      this.permissionsHeldAnywhere(targetUserId),
    ]);
    if (exceedsAuthority(actor, target)) throw new PermissionDeniedError();
  }

  /** 403 se alguma atribuição que entra ou sai tiver permissão que o ator não tem no escopo dela. */
  async requireRoleChangesAllowed(actorUserId: string, changes: readonly RoleChange[]): Promise<void> {
    if (changes.length === 0) return;
    const scopes = [...new Set(changes.map((c) => c.branchId))];
    const resolved = new Map<string | null, ReadonlySet<string>>();
    await Promise.all(
      scopes.map(async (branchId) => {
        resolved.set(branchId, await this.authorization.getEffectivePermissions(actorUserId, branchId === null ? TENANT_SCOPE : branchScope(branchId)));
      }),
    );
    if (forbiddenRoleChanges(changes, (branchId) => resolved.get(branchId) ?? new Set()).length > 0) throw new PermissionDeniedError();
  }
}
