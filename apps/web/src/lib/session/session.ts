"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getApiRuntime } from "../api/runtime";
import { createSessionStore, IDLE, type SessionState } from "./session-store";

/** Sessão única da aba. */
export const sessionStore = createSessionStore(getApiRuntime);

const serverSnapshot = (): SessionState => IDLE;

export function useSession(): SessionState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, serverSnapshot);
}

/** Dispara o bootstrap da sessão ao carregar o app (uma vez; ver `SessionStore.start`). */
export function SessionBootstrap(): null {
  useEffect(() => {
    void sessionStore.start();
  }, []);
  return null;
}
