import type { AuthorizationScope } from "./authorization.service.js";

/** Uma atribuição de role do usuário (UserRole) com as permissões da role. */
export interface RoleAssignment {
  /** `null` = role tenant-wide; preenchido = role escopada àquela filial. */
  readonly branchId: string | null;
  readonly permissions: readonly string[];
}

/**
 * Mesma regra do `AuthorizationService.getEffectivePermissions`, em memória, para quem precisa das permissões de VÁRIOS
 * escopos de uma vez (GET /me) sem uma query por filial. Quem chama já filtrou: só usuário ACTIVE e só roles ACTIVE
 * (usuário inativo = nenhuma atribuição). Regras de escopo:
 * - tenant: só atribuições com `branchId = null`;
 * - filial: atribuições tenant-wide + as daquela filial, e SÓ se o usuário tem acesso a ela (`accessibleBranchIds`).
 * Coberto por teste de integração que compara com o AuthorizationService para vários usuários e filiais.
 */
export function resolveEffectivePermissions(
  assignments: readonly RoleAssignment[],
  scope: AuthorizationScope,
  accessibleBranchIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (scope.kind === "branch" && !accessibleBranchIds.has(scope.branchId)) return new Set();
  const effective = new Set<string>();
  for (const assignment of assignments) {
    const applies = assignment.branchId === null || (scope.kind === "branch" && assignment.branchId === scope.branchId);
    if (applies) for (const code of assignment.permissions) effective.add(code);
  }
  return effective;
}

/** Ordem estável por código (comparação de string em código, independente de collation do banco). */
export function sortedPermissionCodes(permissions: Iterable<string>): string[] {
  return [...permissions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
