import { Inject, Injectable, SetMetadata, applyDecorators, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PermissionDeniedError, UnauthenticatedError } from "../auth/errors.js";
import { authOfRequest, type RequestWithAuth } from "../auth/http/auth-decorators.js";
import { AuthorizationService, TENANT_SCOPE, branchScope, type AuthorizationScope } from "./authorization.service.js";

export const REQUIRED_PERMISSIONS = "authz:requiredPermissions";

/** Mesmo formato de `permissions.code` (CHECK do banco). Código inválido falha ao carregar o controller, não em runtime. */
const PERMISSION_CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface PermissionRequirement {
  readonly permissions: readonly string[];
  /** Nome do parâmetro de rota com o id da filial ALVO da operação; ausente = escopo do tenant. */
  readonly branchParam?: string;
}

function requirement(permissions: string[], branchParam?: string): PermissionRequirement {
  if (permissions.length === 0) throw new Error("At least one permission is required");
  for (const code of permissions) if (!PERMISSION_CODE.test(code)) throw new Error(`Invalid permission code: ${code}`);
  return Object.freeze({ permissions: Object.freeze([...permissions]), ...(branchParam ? { branchParam } : {}) });
}

/** Exige TODAS as permissões no escopo do tenant (só roles tenant-wide contam). */
export const RequirePermissions = (...permissions: string[]) => applyDecorators(SetMetadata(REQUIRED_PERMISSIONS, requirement(permissions)));

/**
 * Exige TODAS as permissões na filial identificada pelo parâmetro de rota `branchParam` (roles tenant-wide + roles daquela
 * filial). O parâmetro identifica o RECURSO alvo, não a identidade: a filial é revalidada no tenant autenticado e uma
 * filial inexistente/de outro tenant não concede nada (403).
 */
export const RequireBranchPermissions = (branchParam: string, ...permissions: string[]) =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSIONS, requirement(permissions, branchParam)));

/**
 * Guard global de autorização, registrado DEPOIS do AuthGuard. Sem `@Require*Permissions`, não faz nada. Com:
 * sem AuthContext = 401; sem permissão = 403 (PermissionDeniedError). Controllers dependem de códigos de permissão,
 * nunca de nomes de role.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthContextService) private readonly authContext: AuthContextService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<RequestWithAuth & { params?: Record<string, string | undefined> }>();
    const auth = authOfRequest(request);
    if (!auth) throw new UnauthenticatedError("missing_auth_context");

    let scope: AuthorizationScope = TENANT_SCOPE;
    if (required.branchParam) {
      const branchId = request.params?.[required.branchParam];
      if (typeof branchId !== "string" || branchId.length === 0) throw new PermissionDeniedError();
      scope = branchScope(branchId);
    }
    const allowed = await this.authContext.run(auth, () => this.authorization.hasAllPermissions(auth.userId, required.permissions, scope));
    if (!allowed) throw new PermissionDeniedError();
    return true;
  }
}
