import { deriveRefreshProofKey } from "../auth/tokens/refresh-token.js";

/**
 * Configuração do Auth, lida SOMENTE do ambiente e validada no boot (fail-fast): sem segredo, ou com segredo fraco, a
 * API não sobe, em qualquer ambiente. Nenhum default de segredo existe no código; testes usam um segredo próprio.
 * Os TTLs têm default técnico (DECISION REQUIRED: durações aprovadas pelo produto, docs/open-questions.md).
 */
export interface AuthConfig {
  /** Chave HMAC do access token (HS256). Nunca logada nem devolvida. */
  readonly accessTokenSecret: Uint8Array;
  /** Chave da prova HMAC dos refresh tokens, derivada do mesmo segredo por HKDF com rótulo próprio. */
  readonly refreshTokenProofKey: Uint8Array;
  readonly accessTokenTtlSeconds: number;
  /** Vida ABSOLUTA da sessão (`sessions.expires_at`), fixada no login; a rotação não a estende. */
  readonly refreshTokenTtlSeconds: number;
  readonly issuer: string;
  readonly audience: string;
}

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

export const AUTH_ENV = {
  secret: "AUTH_ACCESS_TOKEN_SECRET",
  accessTtl: "AUTH_ACCESS_TOKEN_TTL_SECONDS",
  refreshTtl: "AUTH_REFRESH_TOKEN_TTL_SECONDS",
} as const;

/** Default técnico: 15 minutos (DECISION REQUIRED). */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Default técnico: 12 horas, um turno de loja (DECISION REQUIRED; afeta também a expiração offline, #5). */
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Mínimo de 32 bytes (256 bits) para HS256 (RFC 7518 §3.2). */
export const MIN_SECRET_BYTES = 32;

const ACCESS_TTL_RANGE = { min: 60, max: 60 * 60 } as const;
const REFRESH_TTL_RANGE = { min: 5 * 60, max: 90 * 24 * 60 * 60 } as const;

export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
}

function readTtl(env: NodeJS.ProcessEnv, name: string, fallback: number, range: { min: number; max: number }): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new AuthConfigError(`${name} must be a positive integer number of seconds`);
  const value = Number(raw);
  if (value < range.min || value > range.max) {
    throw new AuthConfigError(`${name} must be between ${range.min} and ${range.max} seconds`);
  }
  return value;
}

/** Repetição de um único caractere ou de um placeholder conhecido: rejeitado mesmo com comprimento suficiente. */
function looksLikePlaceholder(secret: string): boolean {
  if (new Set(secret).size < 8) return true;
  return /change[-_ ]?me|replace[-_ ]?me|placeholder|example|secret{2,}|^x+$/i.test(secret);
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const secret = env[AUTH_ENV.secret];
  if (!secret) throw new AuthConfigError(`${AUTH_ENV.secret} is not set`);
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new AuthConfigError(`${AUTH_ENV.secret} must have at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (looksLikePlaceholder(secret)) throw new AuthConfigError(`${AUTH_ENV.secret} looks like a placeholder or weak value`);

  const accessTokenTtlSeconds = readTtl(env, AUTH_ENV.accessTtl, DEFAULT_ACCESS_TOKEN_TTL_SECONDS, ACCESS_TTL_RANGE);
  const refreshTokenTtlSeconds = readTtl(env, AUTH_ENV.refreshTtl, DEFAULT_REFRESH_TOKEN_TTL_SECONDS, REFRESH_TTL_RANGE);
  if (refreshTokenTtlSeconds <= accessTokenTtlSeconds) {
    throw new AuthConfigError(`${AUTH_ENV.refreshTtl} must be greater than ${AUTH_ENV.accessTtl}`);
  }

  const accessTokenSecret = new Uint8Array(Buffer.from(secret, "utf8"));
  return Object.freeze({
    accessTokenSecret,
    refreshTokenProofKey: deriveRefreshProofKey(accessTokenSecret),
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    issuer: "erp-api",
    audience: "erp-api",
  });
}
