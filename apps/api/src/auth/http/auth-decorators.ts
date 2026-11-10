import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthContext } from "../context/auth-context.js";
import { UnauthenticatedError } from "../errors.js";

export const IS_PUBLIC = "auth:isPublic";
export const ALLOW_PASSWORD_CHANGE_REQUIRED = "auth:allowPasswordChangeRequired";

/**
 * Rota sem autenticação. O AuthGuard é global e nega por padrão: toda rota exige access token válido, salvo esta marca
 * explícita (ex.: health). Não usar em rota de negócio. SÓ em método: o guard lê apenas o handler, então uma marca na
 * classe (ou herdada de uma classe base pelo prototype chain do Reflect) nunca torna um controller inteiro público.
 */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

/** Rota acessível mesmo com `must_change_password` (ex.: troca de senha, logout). As demais respondem 403. Só em método. */
export const AllowWhenPasswordChangeRequired = (): MethodDecorator => SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED, true);

/** Chave do AuthContext no objeto do request (símbolo: não colide nem é serializado). */
export const REQUEST_AUTH = Symbol("requestAuth");

export type RequestWithAuth = {
  [REQUEST_AUTH]?: AuthContext;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
};

export function authOfRequest(request: RequestWithAuth): AuthContext | undefined {
  return request[REQUEST_AUTH];
}

/** Injeta o AuthContext da request autenticada no handler. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = authOfRequest(ctx.switchToHttp().getRequest<RequestWithAuth>());
  if (!auth) throw new UnauthenticatedError("missing_auth_context");
  return auth;
});
