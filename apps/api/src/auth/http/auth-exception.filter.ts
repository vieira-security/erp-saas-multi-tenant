import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { AuthError } from "../errors.js";

interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): void;
}

/**
 * Converte erros de Auth/autorização em 401/403/400 com SOMENTE o código público (`{ error: "<code>" }`). Motivo interno,
 * mensagem, stack, ids e qualquer dado do usuário nunca vão para a resposta. 401 = não autenticado; 403 = autenticado sem
 * permissão (ou tenant/dispositivo/troca de senha obrigatória).
 */
@Catch(AuthError)
export class AuthExceptionFilter implements ExceptionFilter {
  catch(error: AuthError, host: ArgumentsHost): void {
    const { status, code } = error.publicFailure;
    const response = host.switchToHttp().getResponse<JsonResponse>();
    response.status(status).json({ error: code });
  }
}
