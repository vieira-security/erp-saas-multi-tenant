"use client";

import type { ReactNode } from "react";
import { sessionStore, useSession } from "../lib/session/session";
import type { SessionState } from "../lib/session/session-store";
import { ErrorState, LoadingState, PasswordChangeRequiredState, SessionExpiredState, SignedOutState } from "./states";

type Authenticated = Extract<SessionState, { status: "authenticated" }>;

/** Mostra o estado da sessão (carregando, sem sessão, expirada, troca de senha, erro) e só renderiza com sessão. */
export function SessionGate({ children }: { readonly children: (session: Authenticated) => ReactNode }) {
  const session = useSession();
  const retry = () => void sessionStore.retry();

  switch (session.status) {
    case "idle":
    case "loading":
      return <LoadingState fullScreen label="Carregando sua sessão…" />;
    case "signed_out":
      return <SignedOutState onRetry={retry} />;
    case "expired":
      return <SessionExpiredState onRetry={retry} />;
    case "password_change_required":
      return <PasswordChangeRequiredState />;
    case "error":
      return <ErrorState fullScreen code={session.code} onRetry={retry} />;
    case "authenticated":
      return <>{children(session)}</>;
  }
}
