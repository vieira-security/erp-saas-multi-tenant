/**
 * Erros de domínio do Auth. `code` é estável e é o ÚNICO dado exposto ao cliente (via AuthExceptionFilter), junto com o
 * status HTTP de `publicFailure`. Mensagens internas nunca carregam senha, token, hash nem dado do usuário.
 *
 * Falhas de login são publicamente indistinguíveis (`invalid_credentials`): matrícula inexistente, senha errada,
 * conta desativada, conta bloqueada e bloqueio temporário retornam o mesmo 401. O motivo real fica no erro interno
 * (`reason`) e no AuditLog. Decisão do M2: a resposta externa é sempre genérica.
 */
export abstract class AuthError extends Error {
  abstract readonly code: string;
  /** Status HTTP e código público; vários erros internos compartilham o mesmo para não permitir enumeração. */
  abstract readonly publicFailure: { status: 400 | 401 | 403; code: string };
}

export type LoginFailureReason = "invalid_credentials" | "account_disabled" | "account_locked" | "temporarily_locked";

const INVALID_CREDENTIALS = { status: 401, code: "invalid_credentials" } as const;
const UNAUTHENTICATED = { status: 401, code: "unauthenticated" } as const;

/** Matrícula inexistente ou senha errada (e, publicamente, também conta desativada/bloqueada). */
export class InvalidCredentialsError extends AuthError {
  override readonly name: string = "InvalidCredentialsError";
  readonly code = "invalid_credentials";
  readonly publicFailure = INVALID_CREDENTIALS;
  constructor(readonly reason: LoginFailureReason = "invalid_credentials") {
    super(`Login failed: ${reason}`);
  }
}

export class AccountDisabledError extends InvalidCredentialsError {
  override readonly name = "AccountDisabledError";
  constructor() {
    super("account_disabled");
  }
}

/** `status = LOCKED` (bloqueio de segurança sem prazo) ou `locked_until` no futuro (bloqueio temporário). */
export class AccountLockedError extends InvalidCredentialsError {
  override readonly name = "AccountLockedError";
  constructor(temporary: boolean) {
    super(temporary ? "temporarily_locked" : "account_locked");
  }
}

/** Tenant inexistente para o resolver ou com status que não permite autenticação. */
export class TenantUnavailableError extends AuthError {
  override readonly name = "TenantUnavailableError";
  readonly code = "tenant_unavailable";
  readonly publicFailure = { status: 403, code: "tenant_unavailable" } as const;
  constructor() {
    super("Tenant does not allow authentication");
  }
}

/** Device inexistente no tenant, ou com status que não permite sessão. */
export class DeviceNotAllowedError extends AuthError {
  override readonly name = "DeviceNotAllowedError";
  readonly code = "device_not_allowed";
  readonly publicFailure = { status: 403, code: "device_not_allowed" } as const;
  constructor() {
    super("Device does not allow sessions");
  }
}

/** Ausência, formato ou assinatura inválida do access token; sessão/usuário/dispositivo não mais válidos. */
export class UnauthenticatedError extends AuthError {
  override readonly name = "UnauthenticatedError";
  readonly code = "unauthenticated";
  readonly publicFailure = UNAUTHENTICATED;
  constructor(readonly reason: string = "unauthenticated") {
    super(`Unauthenticated: ${reason}`);
  }
}

export class SessionExpiredError extends AuthError {
  override readonly name = "SessionExpiredError";
  readonly code = "session_expired";
  readonly publicFailure = UNAUTHENTICATED;
  constructor() {
    super("Session expired");
  }
}

export class SessionRevokedError extends AuthError {
  override readonly name = "SessionRevokedError";
  readonly code = "session_revoked";
  readonly publicFailure = UNAUTHENTICATED;
  constructor() {
    super("Session revoked");
  }
}

/** Refresh token malformado ou sem sessão correspondente. */
export class InvalidRefreshTokenError extends AuthError {
  override readonly name = "InvalidRefreshTokenError";
  readonly code = "invalid_refresh_token";
  readonly publicFailure = UNAUTHENTICATED;
  constructor() {
    super("Invalid refresh token");
  }
}

/** Sessão identificada, mas o segredo apresentado não é o atual: possível reuso de token rotacionado. Sessão revogada. */
export class RefreshTokenReplayError extends AuthError {
  override readonly name = "RefreshTokenReplayError";
  readonly code = "refresh_token_replay";
  readonly publicFailure = UNAUTHENTICATED;
  constructor() {
    super("Refresh token replay detected; session revoked");
  }
}

/** Autenticado, mas `must_change_password` exige trocar a senha antes de qualquer outra operação. */
export class PasswordChangeRequiredError extends AuthError {
  override readonly name = "PasswordChangeRequiredError";
  readonly code = "password_change_required";
  readonly publicFailure = { status: 403, code: "password_change_required" } as const;
  constructor() {
    super("Password change required");
  }
}

/** Senha atual errada na troca autenticada (conta para o lockout). */
export class CurrentPasswordInvalidError extends AuthError {
  override readonly name = "CurrentPasswordInvalidError";
  readonly code = "invalid_current_password";
  readonly publicFailure = { status: 403, code: "invalid_current_password" } as const;
  constructor() {
    super("Current password is invalid");
  }
}

/** Senha nova fora da política (tamanho). */
export class PasswordPolicyError extends AuthError {
  override readonly name = "PasswordPolicyError";
  readonly code = "password_policy_violation";
  readonly publicFailure = { status: 400, code: "password_policy_violation" } as const;
  constructor() {
    super("New password does not satisfy the password policy");
  }
}

/** Usuário alvo de operação administrativa inexistente no tenant atual. */
export class UserNotFoundError extends AuthError {
  override readonly name = "UserNotFoundError";
  readonly code = "user_not_found";
  readonly publicFailure = { status: 403, code: "forbidden" } as const;
  constructor() {
    super("User not found in the current tenant");
  }
}

/** Autenticado, mas sem a permissão exigida. */
export class PermissionDeniedError extends AuthError {
  override readonly name = "PermissionDeniedError";
  readonly code = "permission_denied";
  readonly publicFailure = { status: 403, code: "forbidden" } as const;
  constructor() {
    super("Permission denied");
  }
}

/** `Origin`/`Sec-Fetch-Site` fora da allowlist em endpoint que usa o cookie do refresh (CSRF). */
export class UntrustedOriginError extends AuthError {
  override readonly name = "UntrustedOriginError";
  readonly code = "forbidden_origin";
  readonly publicFailure = { status: 403, code: "forbidden_origin" } as const;
  constructor() {
    super("Request origin is not allowed");
  }
}
