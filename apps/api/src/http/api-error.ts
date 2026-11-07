import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { ApiErrorCode, ApiErrorResponse, ValidationIssue } from "@erp/contracts";

/**
 * Erro de negócio/HTTP com código público estável (`@erp/contracts`, `API_ERROR_CODES`). Só `code` e `details` chegam ao
 * cliente; a mensagem interna fica no servidor. Auth/autorização continuam com `AuthError` + `AuthExceptionFilter`
 * (mesmo formato `{ error }`).
 */
export class ApiError extends Error {
  override readonly name: string = "ApiError";
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: ApiErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

/** 404 indistinguível para recurso inexistente ou de outro tenant. */
export class NotFoundError extends ApiError {
  override readonly name = "NotFoundError";
  constructor(resource: string) {
    super(404, "not_found", `${resource} not found in the current tenant`);
  }
}

export class ConflictError extends ApiError {
  override readonly name = "ConflictError";
  constructor(code: ApiErrorCode) {
    super(409, code);
  }
}

export class ValidationFailedError extends ApiError {
  override readonly name = "ValidationFailedError";
  constructor(readonly details: readonly ValidationIssue[]) {
    super(400, "validation_failed", `Validation failed: ${details.map((d) => `${d.field}:${d.issue}`).join(", ")}`);
  }
}

interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): void;
}

/** `ApiError` -> `{ error, details? }` (ApiErrorResponse). Nada além disso vai para a resposta. */
@Catch(ApiError)
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: ApiError, host: ArgumentsHost): void {
    const body: ApiErrorResponse =
      error instanceof ValidationFailedError ? { error: error.code, details: error.details } : { error: error.code };
    host.switchToHttp().getResponse<JsonResponse>().status(error.status).json(body);
  }
}
