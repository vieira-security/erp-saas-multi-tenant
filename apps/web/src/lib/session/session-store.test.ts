import { describe, expect, it, vi } from "vitest";
import { createErpApi } from "../api/endpoints";
import { createHttpClient } from "../api/http-client";
import { createMockFetch, type MockFetchOptions } from "../api/mocks/mock-fetch";
import type { ApiRuntime } from "../api/runtime";
import { createSessionStore } from "./session-store";

function runtimeWith(fetchImpl: typeof fetch): ApiRuntime {
  const client = createHttpClient({ fetch: fetchImpl });
  return { client, api: createErpApi(client), mocked: true };
}

function storeWith(options: MockFetchOptions = {}) {
  const fetchSpy = vi.fn(createMockFetch(options));
  const runtime = runtimeWith(fetchSpy as typeof fetch);
  return { store: createSessionStore(async () => runtime), runtime, fetchSpy };
}

const refreshCalls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.filter(([url]) => url === "/auth/refresh").length;

describe("session bootstrap", () => {
  it("refresh -> /me + /me/branches -> authenticated", async () => {
    const { store } = storeWith();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    await store.start();
    const state = store.getSnapshot();
    expect(seen).toEqual(["loading", "authenticated"]);
    expect(state.status === "authenticated" && state.branches.map((b) => b.code)).toEqual(["CENTRO", "SHOPPING", "QUIOSQUE-01"]);
  });

  it("start is idempotent (StrictMode double effect = one refresh)", async () => {
    const { store, fetchSpy } = storeWith();
    await Promise.all([store.start(), store.start()]);
    await store.start();
    expect(refreshCalls(fetchSpy)).toBe(1);
  });

  it("without session -> signed_out", async () => {
    const { store } = storeWith({ session: "expired" });
    await store.start();
    expect(store.getSnapshot()).toEqual({ status: "signed_out" });
  });

  it("logout -> signed_out (and stays signed out on retry)", async () => {
    const { store } = storeWith();
    await store.start();
    await store.logout();
    expect(store.getSnapshot()).toEqual({ status: "signed_out" });
    await store.retry();
    expect(store.getSnapshot()).toEqual({ status: "signed_out" });
  });

  it("session ended during use (refresh fails after a 401) -> expired", async () => {
    const { store, runtime } = storeWith();
    await store.start();
    // a API derruba a sessão: o access token deixa de valer e o cookie do refresh também
    await runtime.client.logout();
    runtime.client.establishSession({
      accessToken: "revoked-token",
      tokenType: "Bearer",
      accessTokenExpiresAt: "2026-11-10T00:00:00.000Z",
      sessionExpiresAt: "2026-11-10T00:00:00.000Z",
      mustChangePassword: false,
    });
    await expect(runtime.api.me()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(store.getSnapshot()).toEqual({ status: "expired" });
  });

  it("mustChangePassword -> password_change_required, without calling /me", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/auth/refresh"
        ? Response.json({
            accessToken: "x",
            tokenType: "Bearer",
            accessTokenExpiresAt: "2026-11-10T00:15:00.000Z",
            sessionExpiresAt: "2026-11-10T12:00:00.000Z",
            mustChangePassword: true,
          })
        : Response.json({ error: "password_change_required" }, { status: 403 }),
    );
    const store = createSessionStore(async () => runtimeWith(fetchImpl as typeof fetch));
    await store.start();
    expect(store.getSnapshot()).toEqual({ status: "password_change_required" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("network failure -> error with a stable code, retry recovers", async () => {
    let online = false;
    const real = createMockFetch();
    const fetchImpl = (async (input, init) => {
      if (!online) throw new TypeError("Failed to fetch");
      return real(input, init);
    }) as typeof fetch;
    const store = createSessionStore(async () => runtimeWith(fetchImpl));
    await store.start();
    expect(store.getSnapshot()).toEqual({ status: "error", code: "network_error" });
    online = true;
    await store.retry();
    expect(store.getSnapshot().status).toBe("authenticated");
  });
});
