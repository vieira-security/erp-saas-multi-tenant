/**
 * Proxy do Next para a API (KAN-53). O navegador só fala com a origem do web; o Next repassa:
 *   /auth/:path*  -> ${API_URL}/auth/:path*   (mesmo caminho: o cookie do refresh é `Path=/auth`, `SameSite=Strict`)
 *   /api/:path*   -> ${API_URL}/:path*        (rotas de negócio; o prefixo `/api` só existe no web)
 *
 * `API_URL` é lida só no servidor (sem `NEXT_PUBLIC_`) e entra no manifesto de rotas no `next build`/`next dev`.
 */

export const DEV_API_URL = "http://localhost:3001";

export interface ApiProxyRewrite {
  readonly source: string;
  readonly destination: string;
}

/** `API_URL` explícita; em desenvolvimento, `http://localhost:3001`. Em produção sem `API_URL`: `null` (sem proxy). */
export function resolveApiUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const configured = env["API_URL"]?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("API_URL deve ser http(s).");
    }
    return url.origin + url.pathname.replace(/\/+$/, "");
  }
  return env["NODE_ENV"] === "production" ? null : DEV_API_URL;
}

export function apiProxyRewrites(apiUrl: string): ApiProxyRewrite[] {
  return [
    { source: "/auth/:path*", destination: `${apiUrl}/auth/:path*` },
    { source: "/api/:path*", destination: `${apiUrl}/:path*` },
  ];
}
