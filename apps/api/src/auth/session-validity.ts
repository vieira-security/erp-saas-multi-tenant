import { UserStatus, type TenantStatus } from "../generated/prisma/client.js";
import { isDeviceStatusAllowed, isTenantStatusAllowed } from "./auth-security-policy.js";
import { DeviceNotAllowedError, SessionExpiredError, SessionRevokedError, TenantUnavailableError, UnauthenticatedError, type AuthError } from "./errors.js";
import type { SessionState } from "./persistence/session.repository.js";

/**
 * Regras ÚNICAS para uma sessão continuar valendo, usadas pelo refresh e pelo AuthGuard (a cada request):
 * não revogada, não expirada, usuário `ACTIVE`, dispositivo (se houver) com status permitido e tenant com status
 * permitido. Bloqueio temporário (`locked_until`) NÃO derruba sessões existentes: senão qualquer um que errasse a senha
 * de propósito encerraria as sessões do usuário. Devolve o erro em vez de lançar, para o chamador decidir.
 */
export function sessionInvalidity(session: SessionState, tenantStatus: TenantStatus | null, now: Date): AuthError | null {
  if (session.revokedAt) return new SessionRevokedError();
  if (session.expiresAt <= now) return new SessionExpiredError();
  if (session.user.status !== UserStatus.ACTIVE) return new UnauthenticatedError("user_inactive");
  if (session.device && !isDeviceStatusAllowed(session.device.status)) return new DeviceNotAllowedError();
  if (!tenantStatus || !isTenantStatusAllowed(tenantStatus)) return new TenantUnavailableError();
  return null;
}
