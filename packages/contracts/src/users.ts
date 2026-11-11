import type { BranchSummaryDto } from "./branches.js";
import type { PageQuery } from "./common.js";

/**
 * Funcionários (usuários) do tenant.
 *
 * Leitura (KAN-29):
 * GET  /users                           `user.read`   query ListUsersQuery -> 200 Page<UserSummaryDto>
 * GET  /users/:userId                   `user.read`   -> 200 UserDto | 404 not_found
 *
 * Gestão (todas exigem `user.manage` no escopo do TENANT; ver "Autoridade" abaixo):
 * POST /users                           CreateUserRequest -> 201 UserDto
 *                                       409 employee_number_already_exists | 400 validation_failed
 * PATCH /users/:userId                  UpdateUserRequest -> 200 UserDto | 404
 * PUT  /users/:userId/roles             ReplaceUserRolesRequest -> 200 UserDto | 404
 *                                       409 role_inactive | branch_access_required | last_owner_required
 * POST /users/:userId/deactivate        -> 200 UserDto | 404
 *                                       409 cannot_target_self | last_owner_required | user_has_open_cash_session
 * POST /users/:userId/activate          -> 200 UserDto | 404   (DISABLED -> ACTIVE; LOCKED continua LOCKED)
 * POST /users/:userId/reset-password    ResetUserPasswordRequest -> 200 UserDto | 404
 *                                       409 cannot_target_self (a própria senha muda em POST /auth/password)
 * POST /users/:userId/unlock            -> 200 UserDto | 404
 *
 * - O tenant vem do token; nada de tenant no corpo/query (campo desconhecido = `unknown_field`).
 * - Nunca expõe hash de senha, tentativas de login, bloqueio temporário nem sessões; senha nunca volta na resposta e
 *   nunca vai para log/auditoria.
 * - Ordem da lista: `name` crescente e, em empate, `id` (estável). Exceção à ordem padrão por criação: a lista existe
 *   para o humano achar a pessoa pelo nome.
 *
 * Autoridade (decisão de produto): quem tem `user.manage` (dono e gerente pela matriz padrão) gerencia funcionários,
 * mas nunca acima de si:
 * - o funcionário ALVO não pode ter, em nenhum escopo, permissão que o ator não tenha no escopo do tenant
 *   (ex.: gerente não mexe no dono nem em outro com mais permissões) -> 403 forbidden;
 * - em `PUT /roles`, toda role que ENTRA ou SAI precisa ter só permissões que o ator tem naquele escopo (tenant inteiro
 *   ou a filial da atribuição) -> 403 forbidden (gerente não cria nem promove ninguém a Proprietário/Gerente).
 *
 * Ciclo de vida (decisões de produto):
 * - Matrícula é digitada pelo gestor e é IMUTÁVEL depois de criada (só o nome muda). Mesma normalização do login
 *   (trim + maiúsculo, `[A-Z0-9._-]`, 1–32).
 * - Senha temporária é digitada pelo gestor (política do Auth, mín. 8) e sempre liga `mustChangePassword`.
 * - Funcionário novo nasce ACTIVE, sem roles e sem acesso a filiais (use `/users/:userId/branch-access` e `PUT /roles`).
 * - Desativar = DISABLED + revoga TODAS as sessões na hora; sem exclusão física (histórico de pedidos e caixa).
 *   Ninguém desativa a si mesmo nem o último Proprietário (role OWNER do tenant inteiro) ativo. Reativar é permitido.
 * - Reset de senha = nova temporária + troca obrigatória + zera tentativas e bloqueio temporário + LOCKED -> ACTIVE +
 *   revoga todas as sessões. Em DISABLED troca a senha mas continua DISABLED.
 * - Desbloquear = zera tentativas e bloqueio temporário e LOCKED -> ACTIVE, sem trocar senha nem derrubar sessões.
 * - Ativar, desativar e desbloquear são idempotentes (já no estado pedido = 200 sem mudança e sem auditoria).
 * - Toda mudança gera evento de auditoria (sem senha/hash).
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

export interface CreateUserRequest {
  /** 1–200 caracteres após trim. */
  readonly name: string;
  /** Matrícula; a API faz trim + maiúsculo. `[A-Za-z0-9._-]`, 1–32. Imutável depois de criada. */
  readonly employeeNumber: string;
  /** Senha temporária (política do Auth: mín. 8). Viola a política -> 400 `validation_failed` / `too_short`. */
  readonly temporaryPassword: string;
}

/** Só o nome muda; matrícula é imutável (enviar `employeeNumber` = `unknown_field`). */
export interface UpdateUserRequest {
  readonly name: string;
}

export interface UserRoleAssignmentInput {
  readonly roleId: string;
  /** `null` = tenant inteiro; senão a filial (o usuário precisa ter acesso a ela -> senão 409 branch_access_required). */
  readonly branchId: string | null;
}

/**
 * Conjunto COMPLETO de roles do usuário: a API calcula o que entra e o que sai numa transação. Lista vazia = sem roles.
 * Máximo 50 itens; par (roleId, branchId) repetido -> 400 `validation_failed` / `invalid_value`. Role de outro tenant ou
 * inexistente -> 400 `validation_failed` / `invalid_value` no item. Role que ENTRA com status != ACTIVE -> 409
 * `role_inactive` (atribuição já existente de role inativa pode permanecer).
 */
export interface ReplaceUserRolesRequest {
  readonly roles: readonly UserRoleAssignmentInput[];
}

export interface ResetUserPasswordRequest {
  /** Nova senha temporária (política do Auth). Liga `mustChangePassword`. */
  readonly temporaryPassword: string;
}
