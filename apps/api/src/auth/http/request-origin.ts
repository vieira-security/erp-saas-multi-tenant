import { UntrustedOriginError } from "../errors.js";

type Headers = Record<string, string | string[] | undefined>;

/**
 * Defesa CSRF dos endpoints que dependem do cookie (login, refresh, logout), além do `SameSite=Strict`:
 * - `Origin` presente (todo navegador atual envia em POST) deve estar na allowlist exata `AUTH_ALLOWED_ORIGINS`;
 *   `Origin: null` (sandbox, redirect, file://) é recusado.
 * - Sem `Origin`: se `Sec-Fetch-Site` existir (navegador), só `same-origin`/`none` passam; sem nenhum dos dois, é um
 *   cliente não-navegador, que não está sujeito a CSRF (precisa anexar o cookie por conta própria).
 */
export function assertTrustedOrigin(headers: Headers, allowedOrigins: readonly string[]): void {
  const origin = headers["origin"];
  if (Array.isArray(origin)) throw new UntrustedOriginError();
  if (origin !== undefined) {
    if (!allowedOrigins.includes(origin)) throw new UntrustedOriginError();
    return;
  }
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") throw new UntrustedOriginError();
}
