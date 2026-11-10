import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../../config/auth-config.js";
import { AuthService, type ClientInfo, type IssuedTokens } from "../auth.service.js";
import { InvalidRefreshTokenError } from "../errors.js";
import { PasswordService } from "../password.service.js";
import { AllowWhenPasswordChangeRequired, Public } from "./auth-decorators.js";
import { clearedRefreshCookie, readRefreshCookie, serializeRefreshCookie } from "./refresh-cookie.js";
import { assertTrustedOrigin } from "./request-origin.js";

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/** Corpo devolvido por login e refresh. O refresh token NUNCA vai no corpo: só no cookie HttpOnly. */
export interface AccessTokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  accessTokenExpiresAt: string;
  sessionExpiresAt: string;
  mustChangePassword: boolean;
}

function clientOf(request: HttpRequest): ClientInfo {
  const userAgent = request.headers["user-agent"];
  return { ipAddress: request.ip ?? null, userAgent: typeof userAgent === "string" ? userAgent : null };
}

function stringField(body: unknown, name: string, optional = false): string | undefined {
  const value = body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new BadRequestException("invalid_request");
  return value;
}

/**
 * Transporte HTTP do Auth (decisões de produto do M2). Access token no corpo (o frontend o mantém em memória e envia como
 * `Authorization: Bearer`); refresh token só em cookie HttpOnly/SameSite=Strict/Path=/auth. Login, refresh e logout são
 * `@Public()` (não exigem access token) mas checam `Origin` (CSRF). Controller sem regra de negócio: delega aos services.
 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /** Código público da organização + matrícula + senha (+ deviceKey opcional). Falhas de credencial: 401 genérico. */
  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<AccessTokenResponse> {
    assertTrustedOrigin(request.headers, this.config.allowedOrigins);
    const loginCode = stringField(body, "loginCode");
    const employeeNumber = stringField(body, "employeeNumber") as string;
    const password = stringField(body, "password") as string;
    const deviceKey = stringField(body, "deviceKey", true);
    const tokens = await this.auth.loginWithCode(loginCode, { employeeNumber, password, deviceKey: deviceKey ?? null, client: clientOf(request) });
    return this.respond(tokens, response);
  }

  /** Lê o refresh token SÓ do cookie; rotaciona e devolve novo access token + novo cookie. Falha: cookie limpo + 401. */
  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() request: HttpRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<AccessTokenResponse> {
    assertTrustedOrigin(request.headers, this.config.allowedOrigins);
    const refreshToken = readRefreshCookie(this.config, request.headers["cookie"]);
    try {
      if (!refreshToken) throw new InvalidRefreshTokenError();
      return this.respond(await this.auth.refresh(refreshToken, clientOf(request)), response);
    } catch (error) {
      response.setHeader("Set-Cookie", clearedRefreshCookie(this.config));
      throw error;
    }
  }

  /** Revoga a sessão do cookie (se for o token atual) e limpa o cookie. Sempre 204 (idempotente, sem revelar nada). */
  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() request: HttpRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<void> {
    assertTrustedOrigin(request.headers, this.config.allowedOrigins);
    const refreshToken = readRefreshCookie(this.config, request.headers["cookie"]);
    response.setHeader("Set-Cookie", clearedRefreshCookie(this.config));
    response.setHeader("Cache-Control", "no-store");
    if (refreshToken) await this.auth.logout(refreshToken, clientOf(request));
  }

  /**
   * Troca da própria senha (Bearer). Acessível com must_change_password. Lê só os dois campos esperados; nada do corpo é
   * logado ou ecoado. 204 em sucesso; demais sessões do usuário são revogadas.
   */
  @Post("password")
  @HttpCode(204)
  @AllowWhenPasswordChangeRequired()
  async changePassword(@Body() body: unknown): Promise<void> {
    const currentPassword = stringField(body, "currentPassword") as string;
    const newPassword = stringField(body, "newPassword") as string;
    await this.passwords.changeOwnPassword(currentPassword, newPassword);
  }

  private respond(tokens: IssuedTokens, response: HttpResponse): AccessTokenResponse {
    response.setHeader("Set-Cookie", serializeRefreshCookie(this.config, tokens.refreshToken, tokens.refreshTokenExpiresAt));
    response.setHeader("Cache-Control", "no-store");
    return {
      accessToken: tokens.accessToken,
      tokenType: "Bearer",
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
      sessionExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
      mustChangePassword: tokens.mustChangePassword,
    };
  }
}
