import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import { AUTH_CONFIG, type AuthConfig } from "../../config/auth-config.js";
import { UnauthenticatedError } from "../errors.js";

/** Único algoritmo aceito. `none`, RS*, ES*, outros HS* e qualquer algoritmo não listado são rejeitados pelo jose. */
export const ACCESS_TOKEN_ALGORITHM = "HS256";
/** Tipo do token no header (RFC 9068): impede usar como access token um JWT emitido para outro fim. */
export const ACCESS_TOKEN_TYPE = "at+jwt";
/** Limite de tamanho aceito antes de qualquer parsing. */
const MAX_TOKEN_LENGTH = 4096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Identidade carregada pelo access token. Claims mínimas: nada de permissões, nome, status, hashes ou dados mutáveis. */
export interface AccessTokenSubject {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string | null;
}

export interface VerifiedAccessToken extends AccessTokenSubject {
  readonly tokenId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly tokenId: string;
  readonly expiresAt: Date;
}

/**
 * Access token curto (JWT HS256). Claims: `sub` = userId, `tid` = tenantId, `sid` = sessionId, `did` = deviceId (só quando
 * a sessão tem dispositivo), `jti`, `iat`, `exp`, `iss`, `aud`; header `typ: at+jwt`. Permissões NUNCA vão no token: são
 * resolvidas no backend a cada request (AuthorizationService). O token sozinho não basta: o AuthGuard também exige a
 * sessão ativa no banco, então revogação vale imediatamente.
 */
@Injectable()
export class AccessTokenService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  async issue(subject: AccessTokenSubject, now: Date = new Date()): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAtSeconds = issuedAt + this.config.accessTokenTtlSeconds;
    const tokenId = randomUUID();
    const claims: Record<string, string> = { tid: subject.tenantId, sid: subject.sessionId };
    if (subject.deviceId) claims["did"] = subject.deviceId;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: ACCESS_TOKEN_TYPE })
      .setSubject(subject.userId)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .setJti(tokenId)
      .sign(this.config.accessTokenSecret);
    return { token, tokenId, expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  /**
   * Verifica assinatura, algoritmo (só HS256), `typ`, emissor, audiência, expiração e o formato de cada claim. Qualquer
   * falha vira `UnauthenticatedError` sem detalhes (o motivo do jose não é exposto).
   */
  async verify(token: string, now: Date = new Date()): Promise<VerifiedAccessToken> {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new UnauthenticatedError("malformed_token");
    }
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.config.accessTokenSecret, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        typ: ACCESS_TOKEN_TYPE,
        issuer: this.config.issuer,
        audience: this.config.audience,
        requiredClaims: ["sub", "tid", "sid", "jti", "iat", "exp"],
        currentDate: now,
      }));
    } catch {
      throw new UnauthenticatedError("invalid_token");
    }
    const { sub, tid, sid, did, jti, iat, exp } = payload;
    const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
    if (!isUuid(sub) || !isUuid(tid) || !isUuid(sid) || (did !== undefined && !isUuid(did))) {
      throw new UnauthenticatedError("invalid_claims");
    }
    if (typeof jti !== "string" || typeof iat !== "number" || typeof exp !== "number") {
      throw new UnauthenticatedError("invalid_claims");
    }
    return Object.freeze({
      tenantId: tid,
      userId: sub,
      sessionId: sid,
      deviceId: did ?? null,
      tokenId: jti,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
    });
  }
}
