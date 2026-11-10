import { DeviceStatus, type PrismaClient, type UserStatus } from "../../generated/prisma/client.js";
import type { TenantScope } from "../../tenancy/tenant-scope.js";

export interface NewSession {
  userId: string;
  deviceId: string | null;
  refreshTokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

/** Sessão com o estado do usuário e do dispositivo necessário para validar refresh e requests (uma query). */
export interface SessionState {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly refreshTokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly user: { readonly status: UserStatus; readonly mustChangePassword: boolean };
  readonly device: { readonly status: DeviceStatus } | null;
}

export type SessionDb = Pick<PrismaClient, "session" | "device">;

/**
 * Sessões do tenant atual. Estado derivado (docs/database.md): ativa = `revoked_at IS NULL AND expires_at > agora`.
 * Nunca há DELETE: logout e revogação gravam `revoked_at`. Rotação e revogação são UPDATEs condicionais (compare-and-set),
 * atômicos sem lock explícito: de duas operações concorrentes sobre o mesmo estado, no máximo uma vence.
 */
export class SessionRepository {
  constructor(
    private readonly db: SessionDb,
    private readonly scope: TenantScope,
  ) {}

  async create(input: NewSession): Promise<{ id: string; expiresAt: Date }> {
    const { userId, deviceId, refreshTokenHash, ipAddress, userAgent, expiresAt } = input;
    return this.db.session.create({
      data: this.scope.data({ userId, deviceId, refreshTokenHash, ipAddress, userAgent, expiresAt }),
      select: { id: true, expiresAt: true },
    });
  }

  /**
   * Sessão + status do usuário (e do dispositivo, só se a sessão tiver um). O dispositivo é lido à parte e só quando
   * existe: um `include` opcional custaria uma query a mais em toda sessão sem dispositivo (medido no gate do M2).
   */
  async findState(id: string): Promise<SessionState | null> {
    const session = await this.db.session.findFirst({
      where: this.scope.where({ id }),
      select: {
        id: true,
        userId: true,
        deviceId: true,
        refreshTokenHash: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { status: true, mustChangePassword: true } },
      },
    });
    if (!session) return null;
    const device = session.deviceId
      ? await this.db.device.findFirst({ where: this.scope.where({ id: session.deviceId }), select: { status: true } })
      : null;
    // Sessão com device_id sem dispositivo visível é impossível pela FK composta; tratada como dispositivo revogado.
    return { ...session, device: session.deviceId ? (device ?? { status: DeviceStatus.REVOKED }) : null };
  }

  /**
   * Troca o hash SOMENTE se a sessão ainda tem `expectedHash`, não está revogada nem expirada. `true` = esta chamada
   * rotacionou; `false` = outra rotação/revogação venceu ou a sessão expirou (o chamador relê e decide).
   */
  async rotate(id: string, expectedHash: string, nextHash: string, now: Date): Promise<boolean> {
    const { count } = await this.db.session.updateMany({
      where: this.scope.where({ id, refreshTokenHash: expectedHash, revokedAt: null, expiresAt: { gt: now } }),
      data: { refreshTokenHash: nextHash },
    });
    return count === 1;
  }

  /** Idempotente: `true` só na chamada que efetivamente revogou. */
  async revoke(id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.session.updateMany({ where: this.scope.where({ id, revokedAt: null }), data: { revokedAt: now } });
    return count === 1;
  }

  /** Revoga todas as sessões não revogadas do usuário (opcionalmente mantendo uma). Devolve quantas revogou. */
  async revokeAllForUser(userId: string, now: Date, exceptSessionId?: string): Promise<number> {
    const { count } = await this.db.session.updateMany({
      where: this.scope.where({ userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) }),
      data: { revokedAt: now },
    });
    return count;
  }

  async revokeAllForDevice(deviceId: string, now: Date): Promise<number> {
    const { count } = await this.db.session.updateMany({ where: this.scope.where({ deviceId, revokedAt: null }), data: { revokedAt: now } });
    return count;
  }
}
