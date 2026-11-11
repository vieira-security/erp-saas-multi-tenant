import type { PermissionCode } from "./me.js";
import type { RoleStatus } from "./users.js";

/**
 * Roles do tenant (somente leitura): a tela de funcionários precisa listar as roles para atribuir.
 *
 * GET /roles   `role.read` (tenant) -> 200 RoleDto[]  (todas as roles do tenant, qualquer status)
 *
 * - Ordem: roles do sistema primeiro (`isSystem`), depois `code` (comparação por código, sem collation).
 * - O front decide o que o usuário logado pode atribuir comparando `permissions` da role com as permissões dele no
 *   escopo (tenant em `/me.permissions`, filial em `/me.branches[].permissions`); a API valida de novo.
 * - Criar/editar role customizada: fora desta fase.
 */
export interface RoleDto {
  readonly id: string;
  /** Ex.: `OWNER`, `MANAGER`, `ATTENDANT`, `KITCHEN`. Exibição; o front nunca decide acesso pelo código da role. */
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly status: RoleStatus;
  /** Ordenadas por código. */
  readonly permissions: readonly PermissionCode[];
}
