import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Refresh token opaco, formato `rt1.<tenantId>.<sessionId>.<secret>`:
 * - `tenantId` e `sessionId` NÃO são segredo: servem só para localizar a sessão com TenantScope (tenant_id + id), sem
 *   consulta fora de tenant. Nenhum dos dois é confiado como identidade: um tenant/sessão trocado simplesmente não
 *   encontra sessão com aquele segredo.
 * - `secret`: 32 bytes de `crypto.randomBytes` (256 bits), base64url. É a credencial.
 * - O banco guarda só `sha256$<base64url(SHA-256(secret))>` em `sessions.refresh_token_hash`. Como o segredo tem alta
 *   entropia, SHA-256 é suficiente (Argon2id seria custo sem ganho). Token puro nunca é persistido nem logado.
 */
export const REFRESH_TOKEN_VERSION = "rt1";
const SECRET_BYTES = 32;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FORMAT = new RegExp(`^${REFRESH_TOKEN_VERSION}\\.(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const HASH_PREFIX = "sha256$";

export interface ParsedRefreshToken {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly secret: string;
}

/** Novo segredo de refresh e o hash a persistir. O token completo só existe depois que a sessão tem `id`. */
export function newRefreshSecret(): { secret: string; hash: string } {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { secret, hash: hashRefreshSecret(secret) };
}

export function hashRefreshSecret(secret: string): string {
  return HASH_PREFIX + createHash("sha256").update(secret, "utf8").digest("base64url");
}

export function formatRefreshToken(tenantId: string, sessionId: string, secret: string): string {
  return `${REFRESH_TOKEN_VERSION}.${tenantId}.${sessionId}.${secret}`;
}

/** `null` para qualquer coisa fora do formato exato (sem normalização além de nada: UUIDs em minúsculas). */
export function parseRefreshToken(token: unknown): ParsedRefreshToken | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const match = FORMAT.exec(token);
  if (!match) return null;
  const [, tenantId, sessionId, secret] = match as unknown as [string, string, string, string];
  return { tenantId, sessionId, secret };
}

/** Comparação em tempo constante de dois hashes de refresh. */
export function refreshHashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
