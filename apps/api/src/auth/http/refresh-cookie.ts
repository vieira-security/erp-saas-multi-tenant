import type { AuthConfig } from "../../config/auth-config.js";

/**
 * Política do cookie do refresh token (decisão de produto do M2). O refresh token só existe neste cookie: nunca no corpo
 * da resposta, em `localStorage` ou acessível por JavaScript.
 * - `HttpOnly`: invisível ao JavaScript (XSS não o lê).
 * - `Secure` (+ prefixo `__Secure-`, que o navegador só aceita com Secure) em produção; desligável só fora de produção.
 * - `SameSite=Strict`: o navegador não o envia em requisição originada por outro site (base da defesa CSRF, junto com a
 *   checagem de `Origin`).
 * - `Path=/auth`: só vai para os endpoints do Auth (refresh e logout), nunca para o resto da API.
 * - Sem `Domain`: host-only (subdomínios não o recebem nem o sobrescrevem com o mesmo escopo).
 * - `Max-Age` = vida restante da sessão (12 h absolutas).
 */
export const REFRESH_COOKIE_PATH = "/auth";

export function refreshCookieName(config: Pick<AuthConfig, "cookieSecure">): string {
  return config.cookieSecure ? "__Secure-erp_rt" : "erp_rt";
}

function attributes(config: Pick<AuthConfig, "cookieSecure">): string {
  return `Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Strict${config.cookieSecure ? "; Secure" : ""}`;
}

export function serializeRefreshCookie(config: Pick<AuthConfig, "cookieSecure">, token: string, expiresAt: Date, now = new Date()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${refreshCookieName(config)}=${token}; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}; ${attributes(config)}`;
}

export function clearedRefreshCookie(config: Pick<AuthConfig, "cookieSecure">): string {
  return `${refreshCookieName(config)}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes(config)}`;
}

/**
 * Valor do cookie do refresh no header `Cookie`. `null` se ausente ou se aparecer MAIS DE UMA VEZ (cookie injetado com
 * outro Path/Domain para confundir o servidor: ambiguidade = recusa).
 */
export function readRefreshCookie(config: Pick<AuthConfig, "cookieSecure">, cookieHeader: string | string[] | undefined): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return null;
  const name = refreshCookieName(config);
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] ? values[0] : null;
}
