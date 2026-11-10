import { Inject, Injectable } from "@nestjs/common";
import { SecurityAuditWriter } from "../audit/security-audit.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { UserStatus, type PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { AUTH_SECURITY_POLICY } from "./auth-security-policy.js";
import { AuthContextService } from "./context/auth-context.js";
import { CurrentPasswordInvalidError, PasswordPolicyError, UnauthenticatedError, UserNotFoundError } from "./errors.js";
import { isTemporarilyLocked, recordPasswordFailure } from "./lockout.js";
import { InvalidPasswordHashError, PasswordHasher, isAcceptablePasswordInput } from "./password/password-hasher.js";
import { AuthUserRepository } from "./persistence/auth-user.repository.js";
import { revokeAllForUserIn } from "./session.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Política mínima de senha NOVA: tamanho (em caracteres) e limite de bytes. Nenhuma regra de complexidade foi aprovada. */
export function satisfiesPasswordPolicy(password: unknown): password is string {
  return isAcceptablePasswordInput(password) && [...password].length >= AUTH_SECURITY_POLICY.password.minLength;
}

/**
 * Ciclo de vida da senha. Só o hash Argon2id é persistido; senha nova/temporária nunca vai para log, AuditLog ou erro.
 * Sem recuperação por e-mail (não aprovada).
 */
@Injectable()
export class PasswordService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly authContext: AuthContextService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
  ) {}

  /**
   * Troca autenticada pelo próprio usuário: exige a senha atual (errada conta para o lockout, e durante o bloqueio
   * temporário nada é verificado), grava o novo hash, limpa `must_change_password` e revoga as DEMAIS sessões do usuário
   * (a sessão atual continua).
   */
  async changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
    const auth = this.authContext.require();
    const now = new Date();
    const user = await new AuthUserRepository(this.prisma, this.scope).findById(auth.userId);
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthenticatedError("user_inactive");
    if (isTemporarilyLocked(user, now)) throw new CurrentPasswordInvalidError();

    let valid: boolean;
    try {
      valid = await this.hasher.verify(user.passwordHash, currentPassword);
    } catch (error) {
      if (!(error instanceof InvalidPasswordHashError)) throw error;
      valid = false;
    }
    if (!valid) {
      await recordPasswordFailure(this.prisma, this.scope, { userId: user.id, deviceId: auth.deviceId, now, source: "password_change" }, {});
      throw new CurrentPasswordInvalidError();
    }
    if (!satisfiesPasswordPolicy(newPassword)) throw new PasswordPolicyError();

    const hash = await this.hasher.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await new AuthUserRepository(tx, this.scope).setPasswordHash(user.id, hash, { mustChangePassword: false, resetLockout: true });
      await revokeAllForUserIn(tx, this.scope, user.id, "password_changed", user.id, auth.sessionId);
      await new SecurityAuditWriter(tx, this.scope).record({ action: "auth.password.changed", userId: user.id });
    });
  }

  /**
   * Reset administrativo para senha TEMPORÁRIA, por um usuário autenticado do mesmo tenant. A autorização (ex.:
   * `user.manage`) é do chamador (PermissionGuard): este serviço não decide quem pode resetar. Grava só o hash, marca
   * `must_change_password`, zera contador e bloqueio temporário e revoga TODAS as sessões do alvo. Não altera status:
   * `DISABLED`/`LOCKED` continuam bloqueando o login. Geração e entrega da senha temporária são responsabilidade externa
   * (quem chama); ela nunca é armazenada nem registrada.
   */
  async resetPassword(targetUserId: string, temporaryPassword: string): Promise<void> {
    const actor = this.authContext.require();
    if (typeof targetUserId !== "string" || !UUID.test(targetUserId)) throw new UserNotFoundError();
    if (!satisfiesPasswordPolicy(temporaryPassword)) throw new PasswordPolicyError();
    const hash = await this.hasher.hash(temporaryPassword);
    await this.prisma.$transaction(async (tx) => {
      const updated = await new AuthUserRepository(tx, this.scope).setPasswordHash(targetUserId, hash, { mustChangePassword: true, resetLockout: true });
      if (!updated) throw new UserNotFoundError();
      await revokeAllForUserIn(tx, this.scope, targetUserId, "password_reset", actor.userId);
      await new SecurityAuditWriter(tx, this.scope).record({ action: "auth.password.reset", targetUserId, actorUserId: actor.userId });
    });
  }
}
