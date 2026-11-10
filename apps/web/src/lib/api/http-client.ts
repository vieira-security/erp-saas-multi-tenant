import type { AccessTokenResponse } from "@erp/contracts";
import { ApiError, toApiError } from "./errors";
import { createMemoryTokenStore, type TokenStore } from "./token-store";

/**
 * Cliente HTTP do web (KAN-23).
 * - Same-origin via proxy do Next: negócio em `/api/*`, auth em `/auth/*` (`credentials: "same-origin"`).
 * - Access token só em memória (`TokenStore`), enviado como `Authorization: Bearer`. O refresh token é o cookie HttpOnly
 *   `Path=/auth`: o cliente nunca o lê nem o envia manualmente.
 * - 401 numa rota de negócio: UM refresh por vez (single-flight; a API detecta replay e revoga a sessão se dois refreshes
 *   usarem o mesmo cookie) e a requisição original é repetida uma única vez. Refresh falhou = sessão limpa + evento.
 * - Nunca loga nada: token, cookie, senha e corpo de `/auth/*` não saem daqui.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/** Dados públicos da sessão (sem o token). */
export interface SessionInfo {
  readonly accessTokenExpiresAt: string;
  readonly sessionExpiresAt: string;
  readonly mustChangePassword: boolean;
}

export type RefreshResult = { readonly ok: true; readonly session: SessionInfo } | { readonly ok: false; readonly error: ApiError };

export type SessionEndedListener = () => void;

export interface HttpClient {
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  /** `POST /auth/refresh`, single-flight. Não emite "sessão encerrada" (use no bootstrap). */
  refresh(): Promise<RefreshResult>;
  /** Guarda o token de um login/refresh bem-sucedido (ex.: tela de login, KAN-24). */
  establishSession(response: AccessTokenResponse): SessionInfo;
  /** `POST /auth/logout` e limpa a sessão local (sem evento: o usuário pediu). */
  logout(): Promise<void>;
  hasSession(): boolean;
  onSessionEnded(listener: SessionEndedListener): () => void;
}

export interface HttpClientOptions {
  readonly fetch: typeof fetch;
  readonly tokens?: TokenStore;
  /** Prefixo das rotas de negócio no web (proxy `/api/*`). */
  readonly apiBase?: string;
  /** Prefixo do Auth; precisa ser `/auth` no navegador (cookie `Path=/auth`). */
  readonly authBase?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAccessToken(body: unknown): AccessTokenResponse | null {
  if (
    isRecord(body) &&
    typeof body["accessToken"] === "string" &&
    body["accessToken"] !== "" &&
    body["tokenType"] === "Bearer" &&
    typeof body["accessTokenExpiresAt"] === "string" &&
    typeof body["sessionExpiresAt"] === "string" &&
    typeof body["mustChangePassword"] === "boolean"
  ) {
    return body as unknown as AccessTokenResponse;
  }
  return null;
}

/** Caminho relativo da API (`/me`, `/branches/:id`). Rejeita URL absoluta, `//host` e `/auth` (tem cliente próprio). */
function assertApiPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /^\/auth(\/|$|\?)/.test(path)) {
    throw new TypeError("Caminho de API inválido.");
  }
}

export function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetch;
  const tokens = options.tokens ?? createMemoryTokenStore();
  const apiBase = options.apiBase ?? "/api";
  const authBase = options.authBase ?? "/auth";
  const listeners = new Set<SessionEndedListener>();
  let inflightRefresh: Promise<RefreshResult> | null = null;
  // Havia sessão (login/refresh ok) que ainda não terminou: o evento sai uma vez por sessão, não por requisição.
  let sessionActive = false;

  async function send(input: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(input, { ...init, credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(0, "network_error");
    }
  }

  function establishSession(response: AccessTokenResponse): SessionInfo {
    tokens.set(response.accessToken);
    sessionActive = true;
    return {
      accessTokenExpiresAt: response.accessTokenExpiresAt,
      sessionExpiresAt: response.sessionExpiresAt,
      mustChangePassword: response.mustChangePassword,
    };
  }

  async function doRefresh(): Promise<RefreshResult> {
    try {
      const response = await send(`${authBase}/refresh`, { method: "POST", headers: { Accept: "application/json" } });
      const body = await readJson(response);
      if (!response.ok) {
        tokens.clear();
        return { ok: false, error: toApiError(response.status, body) };
      }
      const parsed = parseAccessToken(body);
      if (!parsed) {
        tokens.clear();
        return { ok: false, error: new ApiError(response.status, "unexpected_error") };
      }
      return { ok: true, session: establishSession(parsed) };
    } catch (error) {
      tokens.clear();
      return { ok: false, error: error instanceof ApiError ? error : new ApiError(0, "unexpected_error") };
    }
  }

  function refresh(): Promise<RefreshResult> {
    inflightRefresh ??= doRefresh().finally(() => {
      inflightRefresh = null;
    });
    return inflightRefresh;
  }

  function endSession(): void {
    tokens.clear();
    if (!sessionActive) return;
    sessionActive = false;
    for (const listener of [...listeners]) listener();
  }

  async function sendApi(method: HttpMethod, url: string, options: RequestOptions, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (options.signal) init.signal = options.signal;
    return send(url, init);
  }

  async function request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    assertApiPath(path);
    const url = `${apiBase}${path}${buildQuery(options.query)}`;
    const usedToken = tokens.get();
    let response = await sendApi(method, url, options, usedToken);

    if (response.status === 401) {
      await response.body?.cancel();
      const current = tokens.get();
      // Outra requisição já renovou o token enquanto esta estava no ar: só repete, sem novo refresh.
      if (current === null || current === usedToken) {
        const result = await refresh();
        if (!result.ok) {
          endSession();
          throw new ApiError(401, "unauthenticated");
        }
      }
      response = await sendApi(method, url, options, tokens.get());
      if (response.status === 401) {
        await response.body?.cancel();
        endSession();
        throw new ApiError(401, "unauthenticated");
      }
    }

    const body = await readJson(response);
    if (!response.ok) throw toApiError(response.status, body);
    return body as T;
  }

  async function logout(): Promise<void> {
    try {
      const response = await send(`${authBase}/logout`, { method: "POST" });
      await response.body?.cancel();
    } catch {
      // Sem rede: a sessão local é limpa de qualquer forma; o cookie expira no servidor.
    } finally {
      tokens.clear();
      sessionActive = false;
    }
  }

  return {
    request,
    refresh,
    establishSession,
    logout,
    hasSession: () => tokens.get() !== null,
    onSessionEnded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
