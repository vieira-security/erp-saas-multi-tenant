import type { AccessTokenResponse } from "@erp/contracts";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError } from "./errors";
import { createHttpClient, type HttpClient } from "./http-client";

/**
 * API falsa: tokens `t1`, `t2`... Só o token atual é aceito; cada `/auth/refresh` emite o próximo. `refreshOk = false`
 * faz o refresh responder 401 (cookie inválido/expirado). Os atrasos fazem as requisições realmente se sobreporem.
 */
class FakeApi {
  validToken: string | null = null;
  issued = 0;
  refreshCalls = 0;
  refreshOk = true;
  readonly calls: { url: string; init: RequestInit }[] = [];

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    this.calls.push({ url, init });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url === "/auth/refresh") {
      this.refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!this.refreshOk) return json(401, { error: "unauthenticated" });
      return json(200, this.issue());
    }
    if (url === "/auth/logout") return new Response(null, { status: 204 });
    if (url === "/api/slow" && !this.calls.some((c) => c.url === "/api/slow" && c !== this.calls.at(-1))) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const auth = new Headers(init.headers).get("Authorization");
    if (auth === null || auth !== `Bearer ${this.validToken}`) return json(401, { error: "unauthenticated" });
    if (url.startsWith("/api/forbidden")) return json(403, { error: "forbidden" });
    return json(200, { url, auth });
  });

  issue(): AccessTokenResponse {
    this.issued += 1;
    this.validToken = `t${this.issued}`;
    return {
      accessToken: this.validToken,
      tokenType: "Bearer",
      accessTokenExpiresAt: "2026-11-10T12:15:00.000Z",
      sessionExpiresAt: "2026-11-11T00:00:00.000Z",
      mustChangePassword: false,
    };
  }

  /** O access token atual expira (próxima requisição recebe 401). */
  expireAccessToken(): void {
    this.validToken = "expired-on-server";
  }

  apiCalls(): string[] {
    return this.calls.filter((call) => call.url.startsWith("/api")).map((call) => call.url);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let api: FakeApi;
let client: HttpClient;
let ended: Mock<() => void>;

async function signIn(): Promise<void> {
  const result = await client.refresh();
  expect(result.ok).toBe(true);
}

beforeEach(() => {
  api = new FakeApi();
  client = createHttpClient({ fetch: api.fetch as typeof fetch });
  ended = vi.fn<() => void>();
  client.onSessionEnded(ended);
});

describe("requests", () => {
  it("calls the API same-origin through /api with Bearer and query", async () => {
    await signIn();
    const result = await client.request<{ url: string; auth: string }>("GET", "/branches", {
      query: { page: 2, pageSize: 20, status: undefined },
    });
    expect(result).toEqual({ url: "/api/branches?page=2&pageSize=20", auth: "Bearer t1" });
    const call = api.calls.at(-1);
    expect(call?.init.credentials).toBe("same-origin");
    expect(call?.init.cache).toBe("no-store");
  });

  it("sends JSON bodies", async () => {
    await signIn();
    await client.request("POST", "/companies", { body: { tradeName: "X" } });
    const init = api.calls.at(-1)?.init;
    expect(init?.body).toBe('{"tradeName":"X"}');
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("refuses absolute URLs and /auth paths (never sends the token elsewhere)", async () => {
    await signIn();
    for (const path of ["https://evil.example/me", "//evil.example/me", "me", "/auth/refresh", "/auth"]) {
      await expect(client.request("GET", path)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("types errors by contract code without refreshing on 403", async () => {
    await signIn();
    const error = await client.request("GET", "/forbidden").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("forbidden");
    expect(api.refreshCalls).toBe(1);
  });

  it("maps network failures to network_error", async () => {
    const offline = createHttpClient({ fetch: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) });
    const error = await offline.request("GET", "/me").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("network_error");
    expect((error as ApiError).status).toBe(0);
  });
});

describe("401 -> refresh", () => {
  it("N simultaneous 401s trigger a single refresh and each request is retried once", async () => {
    await signIn();
    api.expireAccessToken();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.request<{ auth: string }>("GET", `/items/${i}`)),
    );
    expect(api.refreshCalls).toBe(2); // 1 do signIn + 1 único para os 8
    expect(results.every((r) => r.auth === "Bearer t2")).toBe(true);
    // 8 originais + 8 repetições, nenhuma terceira tentativa
    expect(api.apiCalls()).toHaveLength(16);
    for (let i = 0; i < 8; i += 1) {
      expect(api.apiCalls().filter((u) => u === `/api/items/${i}`)).toHaveLength(2);
    }
    expect(ended).not.toHaveBeenCalled();
  });

  it("a 401 arriving after another request already refreshed only retries (no second refresh)", async () => {
    await signIn();
    api.expireAccessToken();
    // /slow sai com o token velho e só responde (401) depois que /fast já renovou o token
    const slow = client.request<{ auth: string }>("GET", "/slow");
    const fast = await client.request<{ auth: string }>("GET", "/fast");
    expect(fast.auth).toBe("Bearer t2");
    await expect(slow).resolves.toEqual({ url: "/api/slow", auth: "Bearer t2" });
    expect(api.refreshCalls).toBe(2);
  });

  it("retries the original request only once", async () => {
    await signIn();
    api.expireAccessToken();
    // o refresh "funciona", mas o servidor continua recusando o token novo
    const originalIssue = api.issue.bind(api);
    vi.spyOn(api, "issue").mockImplementation(() => {
      const token = originalIssue();
      api.validToken = "never-valid";
      return token;
    });
    const error = await client.request("GET", "/me").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("unauthenticated");
    expect(api.apiCalls()).toEqual(["/api/me", "/api/me"]);
    expect(api.refreshCalls).toBe(2);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(client.hasSession()).toBe(false);
  });

  it("refresh failure clears the session and emits 'session ended' once", async () => {
    await signIn();
    api.expireAccessToken();
    api.refreshOk = false;
    const errors = await Promise.all(
      Array.from({ length: 5 }, (_, i) => client.request("GET", `/x/${i}`).catch((e: unknown) => e)),
    );
    expect(errors.every((e) => e instanceof ApiError && e.code === "unauthenticated")).toBe(true);
    expect(api.refreshCalls).toBe(2);
    expect(api.apiCalls()).toHaveLength(5); // nenhuma repetição sem token novo
    expect(client.hasSession()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("without a previous session, a failed refresh does not emit 'session ended'", async () => {
    api.refreshOk = false;
    await expect(client.request("GET", "/me")).rejects.toMatchObject({ code: "unauthenticated" });
    expect(ended).not.toHaveBeenCalled();
  });
});

describe("bootstrap refresh and logout", () => {
  it("refresh() is single-flight and returns public session info only", async () => {
    const [a, b, c] = await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(api.refreshCalls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual({
      ok: true,
      session: {
        accessTokenExpiresAt: "2026-11-10T12:15:00.000Z",
        sessionExpiresAt: "2026-11-11T00:00:00.000Z",
        mustChangePassword: false,
      },
    });
    expect(JSON.stringify(a)).not.toContain("t1");
    expect(api.calls[0]?.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(api.calls[0]?.init.body).toBeUndefined();
  });

  it("refresh() reports unauthenticated without emitting", async () => {
    api.refreshOk = false;
    const result = await client.refresh();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("unauthenticated");
    expect(ended).not.toHaveBeenCalled();
  });

  it("logout calls /auth/logout and forgets the token", async () => {
    await signIn();
    await client.logout();
    expect(api.calls.at(-1)?.url).toBe("/auth/logout");
    expect(client.hasSession()).toBe(false);
    expect(ended).not.toHaveBeenCalled();
  });
});

describe("token storage", () => {
  const storageCalls: string[] = [];
  const spyStorage = (): Storage =>
    ({
      length: 0,
      clear: vi.fn(),
      key: vi.fn(),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn((key: string, value: string) => storageCalls.push(`${key}=${value}`)),
    }) as unknown as Storage;

  afterEach(() => {
    vi.unstubAllGlobals();
    storageCalls.length = 0;
  });

  it("never writes the token to localStorage, sessionStorage, cookies or IndexedDB", async () => {
    const local = spyStorage();
    const session = spyStorage();
    const cookieWrites: string[] = [];
    const indexedDbOpen = vi.fn();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("indexedDB", { open: indexedDbOpen });
    vi.stubGlobal("document", {
      get cookie() {
        return "";
      },
      set cookie(value: string) {
        cookieWrites.push(value);
      },
    });

    await signIn();
    await client.request("GET", "/me");
    api.expireAccessToken();
    await Promise.all([client.request("GET", "/me"), client.request("GET", "/me/branches")]);
    await client.logout();

    expect(api.issued).toBe(2);
    expect(local.setItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(storageCalls).toEqual([]);
    expect(cookieWrites).toEqual([]);
    expect(indexedDbOpen).not.toHaveBeenCalled();
  });

  it("never logs (token, cookie or /auth bodies)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    await signIn();
    api.expireAccessToken();
    api.refreshOk = false;
    await client.request("GET", "/me").catch(() => undefined);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
