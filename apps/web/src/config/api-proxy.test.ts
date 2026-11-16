import { getRewrittenUrl, isRewrite, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { apiProxyRewrites, DEV_API_URL, resolveApiUrl } from "./api-proxy";

async function rewriteOf(path: string): Promise<string | null> {
  const response = await unstable_getResponseFromNextConfig({ url: `http://localhost:3000${path}`, nextConfig });
  return isRewrite(response) ? getRewrittenUrl(response) : null;
}

describe("resolveApiUrl", () => {
  it("defaults to localhost:3001 outside production", () => {
    expect(resolveApiUrl({})).toBe(DEV_API_URL);
    expect(resolveApiUrl({ NODE_ENV: "development" })).toBe("http://localhost:3001");
  });

  it("uses API_URL without trailing slash", () => {
    expect(resolveApiUrl({ API_URL: "http://api.internal:8080/" })).toBe("http://api.internal:8080");
    expect(resolveApiUrl({ API_URL: " https://api.example.com/v1/ ", NODE_ENV: "production" })).toBe(
      "https://api.example.com/v1",
    );
  });

  it("disables the proxy in production without API_URL", () => {
    expect(resolveApiUrl({ NODE_ENV: "production" })).toBeNull();
  });

  it("rejects non-http API_URL", () => {
    expect(() => resolveApiUrl({ API_URL: "file:///etc/passwd" })).toThrow();
  });
});

describe("apiProxyRewrites", () => {
  it("keeps /auth and strips /api", () => {
    expect(apiProxyRewrites("http://x:1")).toEqual([
      { source: "/auth/:path*", destination: "http://x:1/auth/:path*" },
      { source: "/api/:path*", destination: "http://x:1/:path*" },
    ]);
  });
});

// `unstable_getResponseFromNextConfig` monta a URL final só com o hostname (descarta a porta do destino); por isso os
// testes de roteamento usam API_URL sem porta. A porta do default de dev é coberta por `resolveApiUrl`/`apiProxyRewrites`.
describe("next.config rewrites", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("maps /auth/* to the API keeping the /auth path (cookie Path=/auth)", async () => {
    vi.stubEnv("API_URL", "http://api.internal");
    await expect(rewriteOf("/auth/refresh")).resolves.toBe("http://api.internal/auth/refresh");
    await expect(rewriteOf("/auth/login")).resolves.toBe("http://api.internal/auth/login");
    await expect(rewriteOf("/auth/logout")).resolves.toBe("http://api.internal/auth/logout");
  });

  it("maps /api/* to the API root, with nested paths and query string", async () => {
    vi.stubEnv("API_URL", "http://api.internal");
    await expect(rewriteOf("/api/me")).resolves.toBe("http://api.internal/me");
    await expect(rewriteOf("/api/me/branches")).resolves.toBe("http://api.internal/me/branches");
    await expect(rewriteOf("/api/branches?page=2&pageSize=20")).resolves.toBe(
      "http://api.internal/branches?page=2&pageSize=20",
    );
  });

  it("uses the dev default when API_URL is unset", async () => {
    vi.stubEnv("API_URL", "");
    await expect(rewriteOf("/api/me")).resolves.toMatch(/^http:\/\/localhost(:3001)?\/me$/);
  });

  it("does not proxy app pages", async () => {
    await expect(rewriteOf("/branches/0193a1b2-0000-7000-8000-000000000001")).resolves.toBeNull();
    await expect(rewriteOf("/")).resolves.toBeNull();
  });

  it("transpiles @erp/contracts", () => {
    expect(nextConfig.transpilePackages).toContain("@erp/contracts");
  });
});
