import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Refresh token opaco, formato `rt1.<tenantId>.<sessionId>.<secret>.<proof>`:
 * - `tenantId` e `sessionId` NÃO são segredo (aparecem no access token e no AuditLog): servem só para localizar a sessão
 *   com TenantScope (tenant_id + id), sem consulta fora de tenant. Nenhum dos dois é confiado como identidade.
 * - `secret`: 32 bytes de `crypto.randomBytes` (256 bits), base64url. É a credencial; o banco guarda só
 *   `sha256$<base64url(SHA-256(secret))>` em `sessions.refresh_token_hash` (SHA-256 basta para segredo de alta entropia;
 *   Argon2id seria custo sem ganho). Token puro nunca é persistido nem logado.
 * - `proof`: HMAC-SHA256(chave derivada, `rt1|tenantId|sessionId|secret`). Prova que o token foi EMITIDO pelo servidor
 *   para aquela sessão. Sem prova válida, o token é só inválido: nada é consultado nem revogado. Isso impede que alguém
 *   que conheça `tenantId` + `sessionId` (não secretos) revogue a sessão alheia enviando um segredo qualquer: só um token
 *   realmente emitido e já rotacionado (replay) revoga. A chave é derivada por HKDF do segredo do Auth com rótulo
 *   próprio (separação de chaves); trocar o segredo invalida todos os refresh tokens.
 */
export const REFRESH_TOKEN_VERSION = "rt1";
const SECRET_BYTES = 32;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const B64_32 = "[A-Za-z0-9_-]{43}";
const FORMAT = new RegExp(`^${REFRESH_TOKEN_VERSION}\\.(${UUID})\\.(${UUID})\\.(${B64_32})\\.(${B64_32})$`);
const HASH_PREFIX = "sha256$";
const PROOF_KEY_INFO = "erp-api refresh-token proof v1";

export interface ParsedRefreshToken {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly secret: string;
}

/** Chave da prova, derivada do segredo do Auth (HKDF-SHA256, rótulo exclusivo: nunca a mesma chave do JWT). */
export function deriveRefreshProofKey(authSecret: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", authSecret, new Uint8Array(0), PROOF_KEY_INFO, 32));
}

/** Novo segredo de refresh e o hash a persistir. O token completo só existe depois que a sessão tem `id`. */
export function newRefreshSecret(): { secret: string; hash: string } {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { secret, hash: hashRefreshSecret(secret) };
}

export function hashRefreshSecret(secret: string): string {
  return HASH_PREFIX + createHash("sha256").update(secret, "utf8").digest("base64url");
}

function proofOf(key: Uint8Array, tenantId: string, sessionId: string, secret: string): string {
  return createHmac("sha256", key).update(`${REFRESH_TOKEN_VERSION}|${tenantId}|${sessionId}|${secret}`, "utf8").digest("base64url");
}

export function formatRefreshToken(key: Uint8Array, tenantId: string, sessionId: string, secret: string): string {
  return `${REFRESH_TOKEN_VERSION}.${tenantId}.${sessionId}.${secret}.${proofOf(key, tenantId, sessionId, secret)}`;
}

/** `null` para formato inexato OU prova inválida (token não emitido por este servidor para este tenant/sessão). */
export function parseRefreshToken(key: Uint8Array, token: unknown): ParsedRefreshToken | null {
  if (typeof token !== "string" || token.length > 256) return null;
  const match = FORMAT.exec(token);
  if (!match) return null;
  const [, tenantId, sessionId, secret, proof] = match as unknown as [string, string, string, string, string];
  if (!constantTimeEqual(proof, proofOf(key, tenantId, sessionId, secret))) return null;
  return { tenantId, sessionId, secret };
}

/** Comparação em tempo constante de dois hashes de refresh. */
export function refreshHashesEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
