/**
 * Código PÚBLICO de login da organização (`tenants.login_code`): resolve em qual tenant a matrícula é procurada antes do
 * login. NÃO é segredo e nunca autentica nem autoriza nada. Normalização: trim + uppercase; formato 4-32 caracteres
 * `[A-Z0-9-]`, sem hífen nas pontas (mesmo CHECK do banco, `tenants_login_code_check`). Validado como ASCII antes do
 * uppercase, como a matrícula.
 */
export const LOGIN_CODE_FORMAT = /^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$/;
const RAW_ALLOWED = /^[A-Za-z0-9-]{4,32}$/;

export function normalizeLoginCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const trimmed = raw.trim();
  if (!RAW_ALLOWED.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  return LOGIN_CODE_FORMAT.test(normalized) ? normalized : null;
}
