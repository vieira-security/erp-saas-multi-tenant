import { Inject, Injectable } from "@nestjs/common";
import { normalizeIp, SecurityAuditWriter } from "../audit/security-audit.js";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth-config.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { UserStatus, type PrismaClient } from "../generated/prisma/client.js";
import { TenantContextService } from "../tenancy/tenant-context.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { AUTH_SECURITY_POLICY, isDeviceStatusAllowed, isTenantStatusAllowed } from "./auth-security-policy.js";
import {
  AccountDisabledError,
  AccountLockedError,
  DeviceNotAllowedError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReplayError,
  SessionExpiredError,
  SessionRevokedError,
  TenantUnavailableError,
} from "./errors.js";
import type { ResolvedLoginTenant } from "./login-tenant.js";
import { AuthDeviceRepository, AuthTenantRepository, type DeviceRef } from "./persistence/auth-lookup.repository.js";
import { isTemporarilyLocked, recordPasswordFailure } from "./lockout.js";
import { sessionInvalidity } from "./session-validity.js";
import { AuthUserRepository, type UserCredentials } from "./persistence/auth-user.repository.js";
import { SessionRepository, type SessionState } from "./persistence/session.repository.js";
import { InvalidPasswordHashError, PasswordHasher, isAcceptablePasswordInput } from "./password/password-hasher.js";
import { AccessTokenService } from "./tokens/access-token.service.js";
import { formatRefreshToken, hashRefreshSecret, newRefreshSecret, parseRefreshToken, refreshHashesEqual } from "./tokens/refresh-token.js";

/** Metadados do cliente, informados pela camada de transporte. Só contexto: nunca identidade nem segurança. */
export interface ClientInfo {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface LoginCommand {
  readonly employeeNumber: string;
  readonly password: string;
  /** Dispositivo declarado (identificador, não segredo). Opcional: sessão sem dispositivo continua permitida. */
  readonly deviceKey?: string | null;
  readonly client?: ClientInfo;
}

/** Tokens entregues ao transporte. O refresh token puro só existe aqui, nunca no banco nem em logs. */
export interface IssuedTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly deviceId: string | null;
  readonly mustChangePassword: boolean;
}

/**
 * Autenticação por matrícula + senha e renovação de sessão. Transport-neutral: não sabe de HTTP, cookie ou storage do
 * cliente. Todo acesso a dado de tenant roda em `TenantContextService.run()` com TenantScope.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Login no tenant já resolvido por um `LoginTenantResolver` confiável. Ordem fixa para não criar oráculos:
   * tenant → dispositivo (identificadores não secretos) → usuário → bloqueios → senha. Toda falha de credencial é
   * `InvalidCredentialsError` (mesmo 401 público); quando não há senha a verificar, gasta-se uma verificação Argon2id
   * equivalente, para o tempo não distinguir matrícula inexistente de senha errada.
   */
  async login(tenant: ResolvedLoginTenant, command: LoginCommand): Promise<IssuedTokens> {
    return this.tenants.run({ tenantId: tenant.tenantId }, async () => {
      const now = new Date();
      const client = sanitizeClient(command.client);
      const audit = new SecurityAuditWriter(this.prisma, this.scope);

      const tenantStatus = await new AuthTenantRepository(this.prisma).findStatus(this.scope.tenantId());
      if (!tenantStatus || !isTenantStatusAllowed(tenantStatus)) throw new TenantUnavailableError();

      const device = await this.resolveDevice(command.deviceKey);
      if (device === "rejected") {
        await audit.record({ action: "auth.login.failed", userId: null, deviceId: null, reason: "device_not_allowed" }, client);
        throw new DeviceNotAllowedError();
      }
      const deviceId = device?.id ?? null;

      const { employeeNumber, password } = command;
      const users = new AuthUserRepository(this.prisma, this.scope);
      const user =
        isEmployeeNumber(employeeNumber) && isAcceptablePasswordInput(password) ? await users.findByEmployeeNumber(employeeNumber) : null;

      if (!user) {
        await this.hasher.burnVerification(password);
        await audit.record({ action: "auth.login.failed", userId: null, deviceId, reason: "invalid_credentials" }, client);
        throw new InvalidCredentialsError();
      }

      const blocked = blockedReason(user, now);
      if (blocked) {
        // Sem verificar a senha: durante o bloqueio não existe oráculo de senha certa/errada, e o contador não cresce.
        await this.hasher.burnVerification(password);
        await audit.record({ action: "auth.login.failed", userId: user.id, deviceId, reason: blocked.reason }, client);
        throw blocked.error;
      }

      if (!(await this.verifyPassword(user, password))) {
        await recordPasswordFailure(this.prisma, this.scope, { userId: user.id, deviceId, now }, client);
        throw new InvalidCredentialsError();
      }

      const rehashed = this.hasher.needsRehash(user.passwordHash) ? await this.hasher.hash(password) : null;
      const refresh = newRefreshSecret();
      const session = await this.prisma.$transaction(async (tx) => {
        await new AuthUserRepository(tx, this.scope).registerSuccessfulLogin(user.id, now, rehashed);
        const created = await new SessionRepository(tx, this.scope).create({
          userId: user.id,
          deviceId,
          refreshTokenHash: refresh.hash,
          ipAddress: client.ipAddress,
          userAgent: client.userAgent,
          expiresAt: new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000),
        });
        await new SecurityAuditWriter(tx, this.scope).record(
          { action: "auth.login.succeeded", userId: user.id, sessionId: created.id, deviceId },
          client,
        );
        return created;
      });

      return this.issueTokens(user.id, session, deviceId, refresh.secret, user.mustChangePassword, now);
    });
  }

  /**
   * Rotação do refresh token. O token antigo deixa de valer no mesmo UPDATE condicional que grava o novo hash; de dois
   * refreshes concorrentes com o mesmo token, no máximo um rotaciona. Token com prova válida (emitido pelo servidor) cujo
   * segredo não é o atual = replay de token já rotacionado (ou corrida de dois refreshes): a sessão é revogada. Token sem
   * prova válida nunca chega ao banco nem revoga nada.
   */
  async refresh(refreshToken: string, clientInfo?: ClientInfo): Promise<IssuedTokens> {
    const parsed = parseRefreshToken(this.config.refreshTokenProofKey, refreshToken);
    if (!parsed) throw new InvalidRefreshTokenError();
    const client = sanitizeClient(clientInfo);

    // A prova HMAC já foi conferida (token emitido por este servidor para este tenant/sessão). O tenant só ESCOPA a busca.
    return this.tenants.run({ tenantId: parsed.tenantId }, async () => {
      const now = new Date();
      const sessions = new SessionRepository(this.prisma, this.scope);
      const session = await sessions.findState(parsed.sessionId);
      if (!session) throw new InvalidRefreshTokenError();

      const presentedHash = hashRefreshSecret(parsed.secret);
      if (!refreshHashesEqual(session.refreshTokenHash, presentedHash)) {
        if (session.revokedAt) throw new SessionRevokedError();
        await this.revokeForReplay(session, client);
        throw new RefreshTokenReplayError();
      }
      await this.assertSessionUsable(session, now);

      const next = newRefreshSecret();
      if (!(await sessions.rotate(session.id, presentedHash, next.hash, now))) {
        // Outra operação venceu entre a leitura e o UPDATE: revogação, expiração ou outra rotação (replay/corrida).
        const current = await sessions.findState(session.id);
        if (!current || current.revokedAt) throw new SessionRevokedError();
        if (current.expiresAt <= now) throw new SessionExpiredError();
        await this.revokeForReplay(current, client);
        throw new RefreshTokenReplayError();
      }

      return this.issueTokens(session.userId, session, session.deviceId, next.secret, session.user.mustChangePassword, now);
    });
  }

  /** Mesmas regras do AuthGuard (session-validity.ts), exceto o hash, verificado à parte. */
  private async assertSessionUsable(session: SessionState, now: Date): Promise<void> {
    const tenantStatus = await new AuthTenantRepository(this.prisma).findStatus(this.scope.tenantId());
    const invalid = sessionInvalidity(session, tenantStatus, now);
    if (invalid) throw invalid;
  }

  private async revokeForReplay(session: SessionState, client: SanitizedClient): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await new SessionRepository(tx, this.scope).revoke(session.id, new Date());
      const audit = new SecurityAuditWriter(tx, this.scope);
      await audit.record({ action: "auth.refresh.replay_detected", sessionId: session.id, userId: session.userId, deviceId: session.deviceId }, client);
      if (revoked) {
        await audit.record({ action: "auth.session.revoked", sessionId: session.id, actorUserId: null, reason: "replay_detected" }, client);
      }
    });
  }

  /** `undefined` = sem dispositivo; `"rejected"` = dispositivo declarado inexistente no tenant ou sem permissão de sessão. */
  private async resolveDevice(deviceKey: string | null | undefined): Promise<DeviceRef | undefined | "rejected"> {
    if (deviceKey === undefined || deviceKey === null) return undefined;
    if (typeof deviceKey !== "string" || deviceKey.length === 0 || deviceKey.length > AUTH_SECURITY_POLICY.input.maxDeviceKeyLength) {
      return "rejected";
    }
    const device = await new AuthDeviceRepository(this.prisma, this.scope).findByKey(deviceKey);
    return device && isDeviceStatusAllowed(device.status) ? device : "rejected";
  }

  /** Hash armazenado inválido conta como senha errada (falha genérica), nunca como sucesso nem erro 500 com detalhes. */
  private async verifyPassword(user: UserCredentials, password: string): Promise<boolean> {
    try {
      return await this.hasher.verify(user.passwordHash, password);
    } catch (error) {
      if (error instanceof InvalidPasswordHashError) return false;
      throw error;
    }
  }

  private async issueTokens(
    userId: string,
    session: { id: string; expiresAt: Date },
    deviceId: string | null,
    secret: string,
    mustChangePassword: boolean,
    now: Date,
  ): Promise<IssuedTokens> {
    const tenantId = this.scope.tenantId();
    const access = await this.accessTokens.issue({ tenantId, userId, sessionId: session.id, deviceId }, now);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: formatRefreshToken(this.config.refreshTokenProofKey, tenantId, session.id, secret),
      refreshTokenExpiresAt: session.expiresAt,
      sessionId: session.id,
      userId,
      tenantId,
      deviceId,
      mustChangePassword,
    };
  }
}

interface SanitizedClient {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

function sanitizeClient(client: ClientInfo | undefined): SanitizedClient {
  const userAgent = typeof client?.userAgent === "string" ? client.userAgent.slice(0, AUTH_SECURITY_POLICY.input.maxUserAgentLength) : null;
  return { ipAddress: normalizeIp(client?.ipAddress), userAgent: userAgent || null };
}

function isEmployeeNumber(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= AUTH_SECURITY_POLICY.input.maxEmployeeNumberLength;
}

/**
 * Semântica (proposta, ver docs/security.md): `DISABLED` e `LOCKED` (status) bloqueiam sem prazo e só uma ação
 * administrativa os altera; o Auth nunca muda o status. `locked_until` no futuro é o bloqueio TEMPORÁRIO do lockout.
 */
function blockedReason(user: UserCredentials, now: Date): { reason: "account_disabled" | "account_locked" | "temporarily_locked"; error: InvalidCredentialsError } | null {
  if (user.status === UserStatus.DISABLED) return { reason: "account_disabled", error: new AccountDisabledError() };
  if (user.status === UserStatus.LOCKED) return { reason: "account_locked", error: new AccountLockedError(false) };
  if (isTemporarilyLocked(user, now)) return { reason: "temporarily_locked", error: new AccountLockedError(true) };
  return null;
}
