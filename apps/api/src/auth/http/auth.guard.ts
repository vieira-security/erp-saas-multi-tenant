import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PRISMA_CLIENT } from "../../database/database.module.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { TenantContextService } from "../../tenancy/tenant-context.js";
import { TenantScope } from "../../tenancy/tenant-scope.js";
import type { AuthContext } from "../context/auth-context.js";
import { PasswordChangeRequiredError, UnauthenticatedError } from "../errors.js";
import { AuthTenantRepository } from "../persistence/auth-lookup.repository.js";
import { SessionRepository } from "../persistence/session.repository.js";
import { sessionInvalidity } from "../session-validity.js";
import { AccessTokenService } from "../tokens/access-token.service.js";
import { ALLOW_PASSWORD_CHANGE_REQUIRED, IS_PUBLIC, REQUEST_AUTH, type RequestWithAuth } from "./auth-decorators.js";

/**
 * Extração do access token: header `Authorization: Bearer <token>`. É a forma de a API RECEBER o token; não decide onde
 * o frontend o guarda (memória, cookie HttpOnly via BFF...), decisão em aberto (docs/open-questions.md).
 */
export function extractBearerToken(request: RequestWithAuth): string | null {
  // O Node mantém só o PRIMEIRO Authorization repetido e descarta os demais; um proxy pode ler o último. Ambiguidade =
  // recusa (fail-closed): mais de um header Authorization nunca autentica.
  const raw = request.rawHeaders ?? [];
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) if (raw[i]?.toLowerCase() === "authorization") count++;
  if (count > 1) return null;
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Guard global de autenticação (deny by default). Para cada request não `@Public()`:
 * 1. extrai o Bearer; 2. verifica o JWT (assinatura, HS256, typ, iss/aud, exp, claims);
 * 3. no tenant do TOKEN (nunca de header/body/query/param), carrega a sessão com TenantScope e exige: mesmo usuário e
 *    dispositivo das claims, não revogada, não expirada, usuário ACTIVE, dispositivo e tenant permitidos;
 * 4. grava o AuthContext congelado no request. O AuthContextInterceptor executa o handler dentro de
 *    `AuthContextService.run()`, que abre também o TenantContext: o contexto nasce do Auth, nunca do cliente.
 * Revogação e desativação valem no request seguinte (a sessão é consultada sempre; o JWT sozinho não basta).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Só HTTP existe hoje; qualquer outro tipo de contexto (rpc/ws) é recusado até ter guard próprio (fail-closed).
    if (context.getType() !== "http") throw new UnauthenticatedError("unsupported_context");
    // Marcas lidas SÓ do handler: nunca da classe nem herdadas por ela (ver `Public`).
    const handler = context.getHandler();
    if (this.reflector.get<boolean>(IS_PUBLIC, handler) === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = extractBearerToken(request);
    if (!token) throw new UnauthenticatedError("missing_token");
    const claims = await this.accessTokens.verify(token);

    const auth = await this.tenants.run({ tenantId: claims.tenantId }, async (): Promise<AuthContext> => {
      const now = new Date();
      const session = await new SessionRepository(this.prisma, this.scope).findState(claims.sessionId);
      if (!session || session.userId !== claims.userId || session.deviceId !== claims.deviceId) {
        throw new UnauthenticatedError("session_mismatch");
      }
      const tenant = await new AuthTenantRepository(this.prisma).findAuthState(claims.tenantId);
      const invalid = sessionInvalidity(session, tenant, now);
      if (invalid) throw invalid;
      return Object.freeze({
        tenantId: claims.tenantId,
        userId: session.userId,
        sessionId: session.id,
        deviceId: session.deviceId,
        mustChangePassword: session.user.mustChangePassword,
      });
    });

    if (auth.mustChangePassword && this.reflector.get<boolean>(ALLOW_PASSWORD_CHANGE_REQUIRED, handler) !== true) {
      throw new PasswordChangeRequiredError();
    }
    request[REQUEST_AUTH] = auth;
    return true;
  }
}
