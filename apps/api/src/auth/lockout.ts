import { SecurityAuditWriter, type AuditClientInfo } from "../audit/security-audit.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { TenantScope } from "../tenancy/tenant-scope.js";
import { AUTH_SECURITY_POLICY } from "./auth-security-policy.js";
import { AuthUserRepository } from "./persistence/auth-user.repository.js";

/**
 * Registra uma senha errada (login ou senha atual na troca), numa transação: incremento atômico do contador (o UPDATE
 * segura o lock da linha até o commit, então tentativas simultâneas são serializadas e nenhuma se perde) e, ao atingir
 * `lockout.maxFailedAttempts`, bloqueio temporário (`locked_until`, contador zerado). Persistido no PostgreSQL: vale para
 * todas as instâncias da API (diferente de rate limit em memória). O status do usuário nunca é alterado.
 */
export async function recordPasswordFailure(
  prisma: PrismaClient,
  scope: TenantScope,
  input: { userId: string; deviceId: string | null; now: Date; source: "login" | "password_change" },
  client: AuditClientInfo,
): Promise<{ locked: boolean }> {
  const { maxFailedAttempts, durationMs } = AUTH_SECURITY_POLICY.lockout;
  return prisma.$transaction(async (tx) => {
    const users = new AuthUserRepository(tx, scope);
    const audit = new SecurityAuditWriter(tx, scope);
    const attempts = await users.incrementFailedAttempts(input.userId);
    await audit.record(
      input.source === "login"
        ? { action: "auth.login.failed", userId: input.userId, deviceId: input.deviceId, reason: "invalid_credentials" }
        : { action: "auth.password.change_failed", userId: input.userId, deviceId: input.deviceId },
      client,
    );
    if (attempts < maxFailedAttempts) return { locked: false };
    const lockedUntil = new Date(input.now.getTime() + durationMs);
    await users.lockTemporarily(input.userId, lockedUntil);
    await audit.record({ action: "auth.lockout.triggered", userId: input.userId, lockedUntil }, client);
    return { locked: true };
  });
}

/** Bloqueio temporário em vigor (`locked_until` no futuro). */
export function isTemporarilyLocked(user: { lockedUntil: Date | null }, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}
