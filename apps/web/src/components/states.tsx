import type { ReactNode } from "react";
import { errorMessage, type ErrorCode } from "../lib/api/errors";

/** Estados de tela padronizados: carregando, vazio, erro, sem permissão (403) e sessão. Textos sem detalhe interno. */

type Tone = "neutral" | "danger" | "warning";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-muted text-muted",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
};

const ICON: Record<Tone, string> = { neutral: "i", danger: "!", warning: "!" };

interface StateProps {
  readonly title: string;
  readonly description?: string;
  readonly tone?: Tone;
  readonly action?: ReactNode;
  /** Ocupa a tela toda (antes do shell existir) ou só a área de conteúdo. */
  readonly fullScreen?: boolean;
}

export function StateMessage({ title, description, tone = "neutral", action, fullScreen = false }: StateProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex flex-col items-center justify-center gap-3 px-4 py-12 text-center ${fullScreen ? "min-h-screen" : ""}`}
    >
      <span aria-hidden className={`flex size-10 items-center justify-center rounded-full text-lg font-semibold ${TONE[tone]}`}>
        {ICON[tone]}
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ActionButton({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
    >
      {children}
    </button>
  );
}

export function LoadingState({ label = "Carregando…", fullScreen = false }: { readonly label?: string; readonly fullScreen?: boolean }) {
  return (
    <div role="status" aria-live="polite" className={`flex items-center justify-center gap-3 py-12 text-muted ${fullScreen ? "min-h-screen" : ""}`}>
      <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function EmptyState({ title, description, action }: Pick<StateProps, "title" | "description" | "action">) {
  return <StateMessage title={title} description={description ?? ""} action={action} />;
}

export function ErrorState({ code, onRetry, fullScreen }: { readonly code: ErrorCode; readonly onRetry?: () => void; readonly fullScreen?: boolean }) {
  return (
    <StateMessage
      tone="danger"
      title="Não foi possível carregar"
      description={errorMessage(code)}
      fullScreen={fullScreen ?? false}
      action={onRetry ? <ActionButton onClick={onRetry}>Tentar de novo</ActionButton> : undefined}
    />
  );
}

export function ForbiddenState({ description, action }: { readonly description?: string; readonly action?: ReactNode }) {
  return (
    <StateMessage
      tone="warning"
      title="Sem permissão"
      description={description ?? "Você não tem permissão para acessar esta área. Fale com o responsável pela conta."}
      action={action}
    />
  );
}

export function SessionExpiredState({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <StateMessage
      fullScreen
      tone="warning"
      title="Sessão encerrada"
      description="Sua sessão expirou ou foi encerrada. Entre novamente para continuar."
      action={<ActionButton onClick={onRetry}>Entrar novamente</ActionButton>}
    />
  );
}

export function SignedOutState({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <StateMessage
      fullScreen
      title="Você não está conectado"
      description="Entre com o código da organização, sua matrícula e senha."
      action={<ActionButton onClick={onRetry}>Tentar de novo</ActionButton>}
    />
  );
}

export function PasswordChangeRequiredState() {
  return (
    <StateMessage
      fullScreen
      tone="warning"
      title="Troca de senha obrigatória"
      description="Antes de continuar, você precisa definir uma nova senha."
    />
  );
}
