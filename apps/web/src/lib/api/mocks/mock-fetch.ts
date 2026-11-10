import {
  BRANCH_STATUSES,
  COMPANY_STATUSES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type AccessTokenResponse,
  type ApiErrorResponse,
  type BranchSummaryDto,
  type MeDto,
  type Page,
  type PermissionCode,
  type ValidationIssue,
} from "@erp/contracts";
import { MOCK_BRANCHES, MOCK_COMPANIES, MOCK_ORGANIZATION, mockMe, type MockProfile } from "./data";

/**
 * `fetch` falso para `NEXT_PUBLIC_API_MOCKS=1`: responde às mesmas URLs que o navegador usaria com o proxy (`/auth/*`,
 * `/api/*`), com os mesmos status/códigos de erro do contrato. Assim o cliente HTTP real (refresh, retry, erros) roda
 * igual com e sem mock. Confere permissão como a API (403 `forbidden`) para exercitar os estados da interface.
 */

export interface MockFetchOptions {
  readonly profile?: MockProfile;
  /** `expired` = não há sessão: `/auth/refresh` responde 401. */
  readonly session?: "active" | "expired";
  /** Atraso artificial por resposta (para ver o estado de carregamento). */
  readonly latencyMs?: number;
}

const MOCK_ACCESS_TOKEN = "mock-access-token";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function error(status: number, code: ApiErrorResponse["error"], details?: readonly ValidationIssue[]): Response {
  const body: ApiErrorResponse = details ? { error: code, details } : { error: code };
  return json(status, body);
}

type QueryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly details: ValidationIssue[] };

interface PageParams {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: string;
  readonly companyId?: string;
}

/** Valida a query como a API: estrita (campo desconhecido = `unknown_field`), inteiros e faixa do contrato. */
function parsePageQuery(params: URLSearchParams, allowed: readonly string[], statuses: readonly string[]): QueryResult<PageParams> {
  const details: ValidationIssue[] = [];
  for (const key of params.keys()) {
    if (!["page", "pageSize", ...allowed].includes(key)) details.push({ field: key, issue: "unknown_field" });
  }
  const int = (field: "page" | "pageSize", fallback: number, max: number): number => {
    const raw = params.get(field);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) {
      details.push({ field, issue: "invalid_type" });
      return fallback;
    }
    const value = Number(raw);
    if (value < 1 || value > max) details.push({ field, issue: "invalid_value" });
    return value;
  };
  const page = int("page", 1, Number.MAX_SAFE_INTEGER);
  const pageSize = int("pageSize", PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const status = params.get("status") ?? undefined;
  if (status !== undefined && !statuses.includes(status)) details.push({ field: "status", issue: "invalid_value" });
  const companyId = params.get("companyId") ?? undefined;
  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: { page, pageSize, ...(status === undefined ? {} : { status }), ...(companyId === undefined ? {} : { companyId }) },
  };
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages: Math.ceil(items.length / pageSize),
  };
}

export function operableBranches(me: MeDto): BranchSummaryDto[] {
  return me.branches
    .filter((b) => b.operable)
    .map(({ id, companyId, name, code, status }) => ({ id, companyId, name, code, status }));
}

export function createMockFetch(options: MockFetchOptions = {}): typeof fetch {
  const me = mockMe(options.profile ?? "mixed");
  const latency = options.latencyMs ?? 0;
  let signedIn = (options.session ?? "active") === "active";

  const can = (permission: PermissionCode): boolean => me.permissions.includes(permission);

  function handle(method: string, url: URL, headers: Headers): Response {
    const path = url.pathname;

    if (path.startsWith("/auth/")) {
      if (method !== "POST") return error(404, "not_found");
      if (path === "/auth/refresh") {
        if (!signedIn) return error(401, "unauthenticated");
        const body: AccessTokenResponse = {
          accessToken: MOCK_ACCESS_TOKEN,
          tokenType: "Bearer",
          accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          sessionExpiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
          mustChangePassword: me.user.mustChangePassword,
        };
        return json(200, body);
      }
      if (path === "/auth/logout") {
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      return error(404, "not_found");
    }

    if (!path.startsWith("/api/")) return error(404, "not_found");
    if (!signedIn || headers.get("Authorization") !== `Bearer ${MOCK_ACCESS_TOKEN}`) return error(401, "unauthenticated");
    if (method !== "GET") return error(404, "not_found");

    const route = path.slice("/api".length);
    switch (route) {
      case "/me":
        return json(200, me);
      case "/me/branches":
        return json(200, operableBranches(me));
      case "/organization":
        return can("organization.read") ? json(200, MOCK_ORGANIZATION) : error(403, "forbidden");
      case "/companies": {
        if (!can("organization.read")) return error(403, "forbidden");
        const query = parsePageQuery(url.searchParams, ["status"], COMPANY_STATUSES);
        if (!query.ok) return error(400, "validation_failed", query.details);
        const { page, pageSize, status } = query.value;
        return json(200, paginate(MOCK_COMPANIES.filter((c) => !status || c.status === status), page, pageSize));
      }
      case "/branches": {
        if (!can("branch.read")) return error(403, "forbidden");
        const query = parsePageQuery(url.searchParams, ["status", "companyId"], BRANCH_STATUSES);
        if (!query.ok) return error(400, "validation_failed", query.details);
        const { page, pageSize, status, companyId } = query.value;
        const items = MOCK_BRANCHES.filter((b) => (!status || b.status === status) && (!companyId || b.companyId === companyId));
        return json(200, paginate(items, page, pageSize));
      }
      default:
        return error(404, "not_found");
    }
  }

  return async (input, init) => {
    const request = new Request(new URL(String(input instanceof Request ? input.url : input), "http://mock.local"), init);
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    return handle(request.method, new URL(request.url), request.headers);
  };
}
