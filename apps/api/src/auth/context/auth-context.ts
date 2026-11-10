import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import { TenantContextService } from "../../tenancy/tenant-context.js";

/**
 * Identidade autenticada da operação em curso, produzida SOMENTE pelo AuthGuard (token verificado + sessão ativa no
 * banco). Separada do TenantContext, que continua só `{ tenantId }`: `run()` abre os dois juntos, com o mesmo tenant.
 */
export interface AuthContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string | null;
  readonly mustChangePassword: boolean;
}

export class AuthContextMissingError extends Error {
  override readonly name = "AuthContextMissingError";
  constructor() {
    super("Authenticated context is missing: the operation must run behind the AuthGuard");
  }
}

/** TenantContext e AuthContext divergentes: só acontece se alguém aninhar um `TenantContextService.run()` indevido. */
export class AuthTenantMismatchError extends Error {
  override readonly name = "AuthTenantMismatchError";
  constructor() {
    super("Tenant context does not match the authenticated tenant");
  }
}

const storage = new AsyncLocalStorage<AuthContext>();

@Injectable()
export class AuthContextService {
  constructor(@Inject(TenantContextService) private readonly tenants: TenantContextService) {}

  /** Executa `fn` com `auth` como identidade e `auth.tenantId` como TenantContext. Nada vaza para fora de `fn`. */
  run<T>(auth: AuthContext, fn: () => T): T {
    const frozen: AuthContext = Object.freeze({
      tenantId: auth.tenantId.toLowerCase(),
      userId: auth.userId,
      sessionId: auth.sessionId,
      deviceId: auth.deviceId,
      mustChangePassword: auth.mustChangePassword,
    });
    return this.tenants.run({ tenantId: frozen.tenantId }, () => storage.run(frozen, fn));
  }

  current(): AuthContext | undefined {
    return storage.getStore();
  }

  /** Identidade atual; falha sem AuthGuard ou se o TenantContext em vigor não for o do usuário autenticado. */
  require(): AuthContext {
    const auth = storage.getStore();
    if (!auth) throw new AuthContextMissingError();
    if (this.tenants.current()?.tenantId !== auth.tenantId) throw new AuthTenantMismatchError();
    return auth;
  }
}
