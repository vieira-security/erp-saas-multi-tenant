import type { BranchSummaryDto, MeDto } from "@erp/contracts";
import { isApiError, type ErrorCode } from "../api/errors";
import type { ApiRuntime } from "../api/runtime";

/**
 * Estado da sessão no navegador. Bootstrap ao carregar o app: `POST /auth/refresh` (cookie HttpOnly) -> `GET /me` +
 * `GET /me/branches`. O que vem do `/me` só monta a interface (esconder menu); a API decide cada operação (403).
 */
export type SessionState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "authenticated"; readonly me: MeDto; readonly branches: readonly BranchSummaryDto[] }
  /** Sem sessão no bootstrap ou depois do logout. */
  | { readonly status: "signed_out" }
  /** A sessão terminou durante o uso (refresh falhou). */
  | { readonly status: "expired" }
  | { readonly status: "password_change_required" }
  | { readonly status: "error"; readonly code: ErrorCode };

export interface SessionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionState;
  /** Idempotente: só roda a partir de `idle` (StrictMode chama effects duas vezes; dois refreshes = replay na API). */
  start(): Promise<void>;
  /** Tenta de novo depois de erro, sessão expirada ou sem sessão. */
  retry(): Promise<void>;
  logout(): Promise<void>;
}

export const IDLE: SessionState = { status: "idle" };

export function createSessionStore(getRuntime: () => Promise<ApiRuntime>): SessionStore {
  let state: SessionState = IDLE;
  const listeners = new Set<() => void>();
  let listeningForSessionEnd = false;

  function set(next: SessionState): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    set({ status: "loading" });
    try {
      const { client, api } = await getRuntime();
      if (!listeningForSessionEnd) {
        listeningForSessionEnd = true;
        client.onSessionEnded(() => set({ status: "expired" }));
      }
      if (!client.hasSession()) {
        const result = await client.refresh();
        if (!result.ok) {
          set(result.error.code === "unauthenticated" ? { status: "signed_out" } : { status: "error", code: result.error.code });
          return;
        }
        if (result.session.mustChangePassword) {
          set({ status: "password_change_required" });
          return;
        }
      }
      const [me, branches] = await Promise.all([api.me(), api.myBranches()]);
      set({ status: "authenticated", me, branches });
    } catch (error) {
      if (!isApiError(error)) {
        set({ status: "error", code: "unexpected_error" });
      } else if (error.code === "password_change_required") {
        set({ status: "password_change_required" });
      } else if (error.code === "unauthenticated") {
        // O cliente já emitiu "sessão encerrada" (expired) se havia sessão; senão, não há sessão.
        if (state.status === "loading") set({ status: "signed_out" });
      } else {
        set({ status: "error", code: error.code });
      }
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    start: () => (state.status === "idle" ? load() : Promise.resolve()),
    retry: () => (state.status === "loading" || state.status === "authenticated" ? Promise.resolve() : load()),
    async logout() {
      const { client } = await getRuntime();
      await client.logout();
      set({ status: "signed_out" });
    },
  };
}
