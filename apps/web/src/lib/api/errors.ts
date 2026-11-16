import {
  API_ERROR_CODES,
  AUTH_ERROR_CODES,
  VALIDATION_ISSUE_CODES,
  type ApiErrorCode,
  type AuthErrorCode,
  type ValidationIssue,
} from "@erp/contracts";

/**
 * Erros do cliente HTTP. O código vem SÓ do contrato (`ApiErrorResponse.error`); qualquer outra coisa vira um código
 * local genérico. A mensagem exibida sai de `errorMessage(code)`, nunca do texto do servidor.
 */
export type ClientErrorCode =
  /** Sem resposta (rede, proxy fora do ar). */
  | "network_error"
  /** Resposta fora do contrato (5xx, corpo inesperado, código desconhecido). */
  | "unexpected_error";

export type ErrorCode = ApiErrorCode | AuthErrorCode | ClientErrorCode;

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...API_ERROR_CODES, ...AUTH_ERROR_CODES]);
const KNOWN_ISSUES: ReadonlySet<string> = new Set<string>(VALIDATION_ISSUE_CODES);

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    /** HTTP status; 0 = sem resposta. */
    readonly status: number,
    readonly code: ErrorCode,
    readonly details: readonly ValidationIssue[] = [],
  ) {
    // Só o código: nada de corpo, URL ou cabeçalhos na mensagem (pode acabar num log).
    super(code);
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ValidationIssue[] =>
    isRecord(item) && typeof item["field"] === "string" && typeof item["issue"] === "string" && KNOWN_ISSUES.has(item["issue"])
      ? [{ field: item["field"], issue: item["issue"] as ValidationIssue["issue"] }]
      : [],
  );
}

/** Converte uma resposta de erro (status + corpo JSON já lido, ou `undefined`) em `ApiError`. */
export function toApiError(status: number, body: unknown): ApiError {
  if (status >= 400 && status < 500 && isRecord(body) && typeof body["error"] === "string" && KNOWN_CODES.has(body["error"])) {
    return new ApiError(status, body["error"] as ApiErrorCode | AuthErrorCode, parseDetails(body["details"]));
  }
  if (status === 401) return new ApiError(status, "unauthenticated");
  if (status === 403) return new ApiError(status, "forbidden");
  if (status === 404) return new ApiError(status, "not_found");
  return new ApiError(status, "unexpected_error");
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  network_error: "Não foi possível falar com o servidor. Verifique a conexão e tente de novo.",
  unexpected_error: "Algo deu errado. Tente de novo em instantes.",
  validation_failed: "Confira os campos destacados.",
  unauthenticated: "Sua sessão terminou. Entre novamente.",
  forbidden: "Você não tem permissão para esta ação.",
  password_change_required: "Troque sua senha para continuar.",
  tenant_unavailable: "A organização está indisponível. Fale com o responsável pela conta.",
  not_found: "Registro não encontrado.",
  forbidden_origin: "Acesso recusado por este endereço.",
  invalid_credentials: "Código, matrícula ou senha inválidos.",
  device_not_allowed: "Este dispositivo não está autorizado.",
};

/** Mensagem pt-BR para o usuário, escolhida pelo código. */
export function errorMessage(code: ErrorCode): string {
  return MESSAGES[code] ?? "Não foi possível concluir a operação.";
}
