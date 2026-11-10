import type { BranchSummaryDto } from "./branches.js";
import type { PageQuery } from "./common.js";

/**
 * Funcionários (usuários) do tenant — SOMENTE LEITURA nesta fase (KAN-29 precisa escolher o usuário).
 * Cadastro, edição, desativação, atribuição de roles e reset de senha ficam para o próximo módulo, com decisão de
 * produto própria.
 *
 * GET /users            `user.read` (tenant)  query ListUsersQuery -> 200 Page<UserSummaryDto>
 *                                              400 validation_failed (query inválida / campo desconhecido)
 * GET /users/:userId    `user.read` (tenant)  -> 200 UserDto | 404 not_found (inexistente ou de outro tenant)
 *
 * - O tenant vem do token; nada de tenant na query.
 * - Nunca expõe hash de senha, tentativas de login, bloqueio temporário nem sessões.
 * - Ordem da lista: `name` crescente e, em empate, `id` (estável). Exceção à ordem padrão por criação: a lista existe
 *   para o humano achar a pessoa pelo nome.
 */

export const USER_STATUSES = ["ACTIVE", "DISABLED", "LOCKED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];

export interface ListUsersQuery extends PageQuery {
  /** Sem filtro = todos os status. */
  readonly status?: UserStatus;
  /**
   * Busca por nome (contém, sem diferenciar maiúsculas/minúsculas) OU matrícula (igual, exata). 1–100 caracteres após
   * trim; vazio após trim = `validation_failed` / `too_short`.
   */
  readonly search?: string;
}

export interface UserSummaryDto {
  readonly id: string;
  readonly name: string;
  /** Matrícula, única no tenant (é o que o funcionário digita no login). */
  readonly employeeNumber: string;
  readonly status: UserStatus;
  readonly createdAt: string;
}

export interface UserRoleAssignmentDto {
  readonly roleId: string;
  /** Código estável da role (ex.: `OWNER`, `MANAGER`). Exibição apenas; o front decide por PERMISSÃO, nunca por role. */
  readonly code: string;
  readonly name: string;
  /** Role INACTIVE não concede permissão; vem na lista para a tela poder mostrar. */
  readonly status: RoleStatus;
  /** `null` = vale no tenant inteiro; senão, a filial onde a role vale. */
  readonly branch: BranchSummaryDto | null;
}

export interface UserDto extends UserSummaryDto {
  readonly mustChangePassword: boolean;
  readonly updatedAt: string;
  /** Ordem: roles do tenant inteiro primeiro, depois por filial (`branch.code`), depois `code`. */
  readonly roles: readonly UserRoleAssignmentDto[];
}
