import { TENANT_SCOPE, branchScope } from "../authorization/authorization.service.js";
import { resolveEffectivePermissions, type RoleAssignment } from "../authorization/effective-permissions.js";

/**
 * O que o ator pode ver do histórico (KAN-41, decisão de 10/11/2026):
 * - eventos COM filial: só das filiais onde ele tem `audit.read` efetivo (role tenant-wide ou daquela filial, E acesso à
 *   filial — mesma regra do AuthorizationService);
 * - eventos SEM filial (tenant): só com `audit.read` E `audit.read_tenant` no escopo do tenant (roles sem filial).
 * - quem vê o tenant (Dono: `audit.read_tenant`) vê TODO o histórico, inclusive filiais a que não tem acesso — decisão
 *   "Dono tudo, gerente nas filiais dele" (resolve o DECISION REQUIRED 1 do PR #30, auditoria de 11/11/2026).
 * Nada visível = 403. A regra vira condição do SQL (nunca filtro depois da página), então `total` segue a mesma regra.
 */
export interface AuditVisibility {
  /** Filiais com `audit.read`, ordenadas (estável). */
  readonly branchIds: readonly string[];
  readonly tenantEvents: boolean;
}

export function auditVisibility(assignments: readonly RoleAssignment[], accessibleBranchIds: ReadonlySet<string>): AuditVisibility {
  const tenant = resolveEffectivePermissions(assignments, TENANT_SCOPE, accessibleBranchIds);
  const branchIds = [...accessibleBranchIds]
    .filter((branchId) => resolveEffectivePermissions(assignments, branchScope(branchId), accessibleBranchIds).has("audit.read"))
    .sort();
  return { branchIds, tenantEvents: tenant.has("audit.read") && tenant.has("audit.read_tenant") };
}

export function seesNothing(visibility: AuditVisibility): boolean {
  return visibility.branchIds.length === 0 && !visibility.tenantEvents;
}
