import { Inject, Injectable } from "@nestjs/common";
import { SecurityAuditWriter, type SessionRevocationReason } from "../audit/security-audit.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { AuthContextService } from "./context/auth-context.js";
import { SessionRepository } from "./persistence/session.repository.js";

/**
 * Logout e revogação. Nunca apaga sessão: grava `revoked_at` (UPDATE condicional, idempotente). Sessão revogada não
 * renova (AuthService.refresh) e deixa de autenticar requests na hora (AuthGuard consulta a sessão a cada request).
 * Tudo no tenant do contexto atual; uma sessão de outro tenant simplesmente não é encontrada.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly authContext: AuthContextService,
  ) {}

  /** Logout da sessão autenticada atual. Idempotente. */
  async logout(): Promise<void> {
    const auth = this.authContext.require();
    await this.revokeSession(auth.sessionId, "logout", auth.userId);
  }

  /**
   * Revoga uma sessão do tenant atual. `true` só se esta chamada revogou (já revogada/inexistente = `false`).
   * Autorização (quem pode revogar a sessão de outro usuário) é responsabilidade do chamador (PermissionGuard).
   */
  async revokeSession(sessionId: string, reason: SessionRevocationReason, actorUserId: string | null): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const revoked = await new SessionRepository(tx, this.scope).revoke(sessionId, new Date());
      if (revoked) await new SecurityAuditWriter(tx, this.scope).record({ action: "auth.session.revoked", sessionId, actorUserId, reason });
      return revoked;
    });
  }

  /** Revoga todas as sessões ativas do usuário (opcionalmente preservando uma). Devolve quantas foram revogadas. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevocationReason,
    actorUserId: string | null,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    return this.prisma.$transaction((tx) => revokeAllForUserIn(tx, this.scope, userId, reason, actorUserId, options.exceptSessionId));
  }

  /**
   * Para quando um dispositivo for revogado: encerra todas as sessões ligadas a ele. Mesmo sem esta chamada, sessões de
   * dispositivo fora de `deviceStatusesAllowed` já são recusadas pelo AuthGuard e pelo refresh.
   */
  async revokeAllForDevice(deviceId: string): Promise<number> {
    return new SessionRepository(this.prisma, this.scope).revokeAllForDevice(deviceId, new Date());
  }
}

/** Versão para uso dentro de uma transação já aberta (troca/reset de senha). */
export async function revokeAllForUserIn(
  tx: Pick<PrismaClient, "session" | "device" | "auditLog">,
  scope: TenantScope,
  userId: string,
  reason: SessionRevocationReason,
  actorUserId: string | null,
  exceptSessionId?: string,
): Promise<number> {
  const count = await new SessionRepository(tx, scope).revokeAllForUser(userId, new Date(), exceptSessionId);
  if (count > 0) await new SecurityAuditWriter(tx, scope).record({ action: "auth.sessions.revoked", userId, actorUserId, reason, count });
  return count;
}
