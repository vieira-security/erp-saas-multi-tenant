import { Inject, Injectable } from "@nestjs/common";
import type { UserDto, ValidationIssue } from "@erp/contracts";
import { SecurityAuditWriter } from "../audit/security-audit.js";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PasswordHasher } from "../auth/password/password-hasher.js";
import { revokeAllForUserIn } from "../auth/session.service.js";
import { AuthorityService, type RoleChange } from "../authorization/authority.js";
import { TENANT_SCOPE } from "../authorization/authorization.service.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { CashSessionStatus, RoleStatus, UserStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../http/api-error.js";
import { isForeignKeyViolation, isUniqueViolation } from "../organization/prisma-errors.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { assignmentKey, type CreateUserInput, type RoleAssignmentInput } from "./user-requests.js";
import { UserService } from "./user.service.js";

/** Código da role cujo último titular ACTIVE tenant-wide não pode sair (decisão de produto: "último Proprietário"). */
export const OWNER_ROLE_CODE = "OWNER";

type Tx = Prisma.TransactionClient;

interface LockedUser {
  status: UserStatus;
  name: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Gestão de funcionários (contrato `users.ts`). A rota já exigiu `user.manage` no tenant (PermissionGuard). Aqui:
 *
 * Ordem das checagens: corpo (400, no controller) -> alvo existe no tenant (404) -> autoridade sobre o alvo (403) ->
 * roles do corpo existem no tenant (400, só PUT /roles) -> autoridade sobre cada role que entra/sai (403) -> regras de
 * negócio (409).
 *
 * Concorrência: toda escrita trava a linha do alvo (`FOR UPDATE`). Desativar e PUT /roles, que podem tirar o último
 * Proprietário, travam ANTES a linha da role `OWNER` do tenant (mutex por tenant, sempre na mesma ordem: role, depois
 * usuário) e só então contam os titulares — a contagem é um comando novo em READ COMMITTED, então enxerga o que a
 * transação concorrente acabou de commitar. SQL bruto sempre com `tenant_id` do TenantContext.
 *
 * Auditoria via SecurityAuditWriter, na mesma transação; operação idempotente sem mudança não grava nada.
 */
@Injectable()
export class UserManagementService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
    @Inject(AuthorityService) private readonly authority: AuthorityService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(UserService) private readonly users: UserService,
  ) {}

  /** Nasce ACTIVE, com troca de senha obrigatória, sem roles e sem acesso a filiais. */
  async create(input: CreateUserInput): Promise<UserDto> {
    const actorUserId = this.auth.require().userId;
    const passwordHash = await this.hasher.hash(input.temporaryPassword);
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: this.scope.data({
            name: input.name,
            employeeNumber: input.employeeNumber,
            passwordHash,
            status: UserStatus.ACTIVE,
            mustChangePassword: true,
          }),
          select: { id: true },
        });
        await this.audit(tx).record({ action: "user.created", targetUserId: user.id, actorUserId });
        return user.id;
      });
    } catch (error) {
      // Também na corrida: a unique (tenant_id, employee_number) decide, e vira 409 (nunca 500).
      if (isUniqueViolation(error)) throw new ConflictError("employee_number_already_exists");
      throw error;
    }
    return this.users.get(id);
  }

  /** Só o nome muda (a matrícula é imutável). Mesmo nome = sem gravação nem auditoria. */
  async rename(targetUserId: string, name: string): Promise<UserDto> {
    const actorUserId = await this.requireManageable(targetUserId);
    await this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, targetUserId);
      if (user.name === name) return;
      await tx.user.update({ where: this.scope.where({ id: targetUserId }), data: { name } });
      await this.audit(tx).record({ action: "user.updated", targetUserId, actorUserId });
    });
    return this.users.get(targetUserId);
  }

  /**
   * Substitui o conjunto de roles: calcula o que entra e o que sai e aplica numa transação. Atribuição já existente
   * (mesma role e escopo) não é tocada, mesmo com role inativa.
   */
  async replaceRoles(targetUserId: string, desired: readonly RoleAssignmentInput[]): Promise<UserDto> {
    const actorUserId = await this.requireManageable(targetUserId);
    try {
      await this.prisma.$transaction(async (tx) => {
        const ownerRoleId = await this.lockOwnerRole(tx);
        const target = await this.lockUser(tx, targetUserId);

        const roles = await this.loadRoles(tx, desired);
        const current = await tx.userRole.findMany({
          where: this.scope.where({ userId: targetUserId }),
          select: { id: true, roleId: true, branchId: true, role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } },
        });
        const desiredKeys = new Set(desired.map(assignmentKey));
        const currentKeys = new Set(current.map(assignmentKey));
        const adding = desired.filter((a) => !currentKeys.has(assignmentKey(a)));
        const removing = current.filter((a) => !desiredKeys.has(assignmentKey(a)));

        const changes: RoleChange[] = [
          ...adding.map((a) => ({ roleId: a.roleId, branchId: a.branchId, permissions: roles.get(a.roleId)!.permissions })),
          ...removing.map((a) => ({ roleId: a.roleId, branchId: a.branchId, permissions: a.role.permissions.map((rp) => rp.permission.code) })),
        ];
        await this.authority.requireRoleChangesAllowed(actorUserId, changes);

        if (adding.some((a) => roles.get(a.roleId)!.status !== RoleStatus.ACTIVE)) throw new ConflictError("role_inactive");
        await this.requireBranchAccess(tx, targetUserId, adding);
        const losesOwner = ownerRoleId !== null && removing.some((a) => a.roleId === ownerRoleId && a.branchId === null);
        if (losesOwner && target.status === UserStatus.ACTIVE) await this.requireAnotherOwner(tx, ownerRoleId, targetUserId);

        if (adding.length === 0 && removing.length === 0) return;
        if (removing.length > 0) await tx.userRole.deleteMany({ where: this.scope.where({ id: { in: removing.map((a) => a.id) } }) });
        if (adding.length > 0) {
          await tx.userRole.createMany({
            data: adding.map((a) => this.scope.data({ userId: targetUserId, roleId: a.roleId, branchId: a.branchId })),
            skipDuplicates: true,
          });
        }
        await this.audit(tx).record({
          action: "user.roles_replaced",
          targetUserId,
          actorUserId,
          added: adding.map(assignmentKey),
          removed: removing.map(assignmentKey),
        });
      });
    } catch (error) {
      // Corrida com a revogação do acesso à filial: a FK composta (user_roles -> user_branch_access) decide.
      if (isForeignKeyViolation(error)) throw new ConflictError("branch_access_required");
      throw error;
    }
    return this.users.get(targetUserId);
  }

  /**
   * DISABLED + `disabled_at` + revoga todas as sessões, numa transação. Idempotente. Nunca a si mesmo, nunca o último
   * Proprietário ACTIVE, nunca quem tem caixa aberto (só o próprio operador fecha o caixa, M6).
   */
  async deactivate(targetUserId: string): Promise<UserDto> {
    const actorUserId = await this.requireManageable(targetUserId);
    if (targetUserId === actorUserId) throw new ConflictError("cannot_target_self");
    await this.prisma.$transaction(async (tx) => {
      const ownerRoleId = await this.lockOwnerRole(tx);
      const target = await this.lockUser(tx, targetUserId);
      if (target.status === UserStatus.DISABLED) return;
      if (ownerRoleId !== null && target.status === UserStatus.ACTIVE) await this.requireAnotherOwner(tx, ownerRoleId, targetUserId);
      const openCash = await tx.cashSession.count({ where: this.scope.where({ openedBy: targetUserId, status: CashSessionStatus.OPEN }) });
      if (openCash > 0) throw new ConflictError("user_has_open_cash_session");

      await tx.user.update({ where: this.scope.where({ id: targetUserId }), data: { status: UserStatus.DISABLED, disabledAt: new Date() } });
      await revokeAllForUserIn(tx, this.scope, targetUserId, "user_disabled", actorUserId);
      await this.audit(tx).record({ action: "user.deactivated", targetUserId, actorUserId });
    });
    return this.users.get(targetUserId);
  }

  /** DISABLED -> ACTIVE (limpa `disabled_at`). ACTIVE e LOCKED ficam como estão (idempotente, sem auditoria). */
  async activate(targetUserId: string): Promise<UserDto> {
    const actorUserId = await this.requireManageable(targetUserId);
    await this.prisma.$transaction(async (tx) => {
      const target = await this.lockUser(tx, targetUserId);
      if (target.status !== UserStatus.DISABLED) return;
      await tx.user.update({ where: this.scope.where({ id: targetUserId }), data: { status: UserStatus.ACTIVE, disabledAt: null } });
      await this.audit(tx).record({ action: "user.activated", targetUserId, actorUserId });
    });
    return this.users.get(targetUserId);
  }

  /**
   * Nova senha temporária (só o hash Argon2id é gravado), troca obrigatória, zera tentativas e bloqueio temporário,
   * LOCKED -> ACTIVE (DISABLED continua DISABLED) e revoga todas as sessões. A própria senha muda em POST /auth/password.
   */
  async resetPassword(targetUserId: string, temporaryPassword: string): Promise<UserDto> {
    const actorUserId = await this.requireManageable(targetUserId);
    if (targetUserId === actorUserId) throw new ConflictError("cannot_target_self");
    const passwordHash = await this.hasher.hash(temporaryPassword);
    await this.prisma.$transaction(async (tx) => {
      const target = await this.lockUser(tx, targetUserId);
      await tx.user.update({
        where: this.scope.where({ id: targetUserId }),
        data: {
          passwordHash,
          mustChangePassword: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
          ...(target.status === UserStatus.LOCKED ? { status: UserStatus.ACTIVE } : {}),
        },
      });
      await revokeAllForUserIn(tx, this.scope, targetUserId, "password_reset", actorUserId);
      // Evento já existente do Auth para reset administrativo (ator + alvo), reaproveitado.
      await this.audit(tx).record({ action: "auth.password.reset", targetUserId, actorUserId });
    });
    return this.users.get(targetUserId);
  }

  /** Zera tentativas e bloqueio temporário, LOCKED -> ACTIVE. Não troca senha nem derruba sessões. Idempotente. */
  async unlock(targetUserId: string): Promise<UserDto> {
    const actorUserId = await this.requireManageable(targetUserId);
    await this.prisma.$transaction(async (tx) => {
      const target = await this.lockUser(tx, targetUserId);
      if (target.failedLoginAttempts === 0 && target.lockedUntil === null && target.status !== UserStatus.LOCKED) return;
      await tx.user.update({
        where: this.scope.where({ id: targetUserId }),
        data: { failedLoginAttempts: 0, lockedUntil: null, ...(target.status === UserStatus.LOCKED ? { status: UserStatus.ACTIVE } : {}) },
      });
      await this.audit(tx).record({ action: "user.unlocked", targetUserId, actorUserId });
    });
    return this.users.get(targetUserId);
  }

  /** 404 (alvo fora do tenant) e depois 403 (alvo com autoridade acima da do ator no tenant). Devolve o ator. */
  private async requireManageable(targetUserId: string): Promise<string> {
    const actorUserId = this.auth.require().userId;
    const target = await this.prisma.user.findUnique({ where: this.scope.where({ id: targetUserId }), select: { id: true } });
    if (!target) throw new NotFoundError("User");
    // Em si mesmo a guarda de administrador não se aplica: as ações sobre si são barradas adiante (409 cannot_target_self)
    // ou permitidas (renomear a si mesmo).
    await this.authority.requireNoGreaterAuthority(actorUserId, targetUserId, TENANT_SCOPE, { guardAdministrators: targetUserId !== actorUserId });
    return actorUserId;
  }

  /** Linha do alvo travada até o commit, com o estado mais recente. */
  private async lockUser(tx: Tx, userId: string): Promise<LockedUser> {
    const rows = await tx.$queryRaw<LockedUser[]>`
      SELECT status::text AS status, name, failed_login_attempts AS "failedLoginAttempts", locked_until AS "lockedUntil"
      FROM users WHERE tenant_id = ${this.scope.tenantId()}::uuid AND id = ${userId}::uuid
      FOR UPDATE`;
    const user = rows[0];
    if (!user) throw new NotFoundError("User");
    return user;
  }

  /** Mutex do "último Proprietário": trava a role OWNER do tenant (`null` se o tenant não tiver essa role). */
  private async lockOwnerRole(tx: Tx): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM roles
      WHERE tenant_id = ${this.scope.tenantId()}::uuid AND code = ${OWNER_ROLE_CODE}
      FOR UPDATE`;
    return rows[0]?.id ?? null;
  }

  /** 409 se o alvo for o único usuário ACTIVE com a role OWNER no tenant inteiro. Chamar com o mutex já travado. */
  private async requireAnotherOwner(tx: Tx, ownerRoleId: string, targetUserId: string): Promise<void> {
    const owners = await tx.user.findMany({
      where: this.scope.where({ status: UserStatus.ACTIVE, roles: { some: { roleId: ownerRoleId, branchId: null } } }),
      select: { id: true },
    });
    const ids = owners.map((o) => o.id);
    if (ids.includes(targetUserId) && ids.length === 1) throw new ConflictError("last_owner_required");
  }

  /** Roles pedidas, no tenant atual. Inexistente ou de outro tenant = 400 `invalid_value` em `roles[i].roleId`. */
  private async loadRoles(tx: Tx, desired: readonly RoleAssignmentInput[]): Promise<Map<string, { status: RoleStatus; permissions: string[] }>> {
    const rows = await tx.role.findMany({
      where: this.scope.where({ id: { in: [...new Set(desired.map((a) => a.roleId))] } }),
      select: { id: true, status: true, permissions: { select: { permission: { select: { code: true } } } } },
    });
    const roles = new Map(rows.map((r) => [r.id, { status: r.status, permissions: r.permissions.map((rp) => rp.permission.code) }]));
    const issues: ValidationIssue[] = [];
    desired.forEach((a, index) => {
      if (!roles.has(a.roleId)) issues.push({ field: `roles[${index}].roleId`, issue: "invalid_value" });
    });
    if (issues.length > 0) throw new ValidationFailedError(issues);
    return roles;
  }

  /** Atribuição escopada que entra exige `UserBranchAccess` do alvo àquela filial (409 `branch_access_required`). */
  private async requireBranchAccess(tx: Tx, userId: string, adding: readonly RoleAssignmentInput[]): Promise<void> {
    const branchIds = [...new Set(adding.flatMap((a) => (a.branchId === null ? [] : [a.branchId])))];
    if (branchIds.length === 0) return;
    const accesses = await tx.userBranchAccess.findMany({ where: this.scope.where({ userId, branchId: { in: branchIds } }), select: { branchId: true } });
    if (accesses.length !== branchIds.length) throw new ConflictError("branch_access_required");
  }

  private audit(tx: Tx): SecurityAuditWriter {
    return new SecurityAuditWriter(tx, this.scope);
  }
}
