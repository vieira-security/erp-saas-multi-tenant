import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { PasswordService } from "../password.service.js";
import { SessionService } from "../session.service.js";
import { AllowWhenPasswordChangeRequired } from "./auth-decorators.js";

/**
 * Transporte HTTP mínimo do Auth: só operações que dependem apenas do access token (Bearer). Login e refresh NÃO têm
 * endpoint: dependem da descoberta do tenant pré-login e do transporte do refresh token (cookie HttpOnly x corpo),
 * ambos DECISION REQUIRED. Controller sem regra de negócio: delega aos services.
 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  /** Encerra a sessão do access token apresentado. Idempotente: 204 sempre que autenticado. */
  @Post("logout")
  @HttpCode(204)
  @AllowWhenPasswordChangeRequired()
  async logout(): Promise<void> {
    await this.sessions.logout();
  }

  /**
   * Troca da própria senha (Bearer). Acessível com must_change_password. Lê só os dois campos esperados; nada do corpo é
   * logado ou ecoado. 204 em sucesso; demais sessões do usuário são revogadas.
   */
  @Post("password")
  @HttpCode(204)
  @AllowWhenPasswordChangeRequired()
  async changePassword(@Body() body: unknown): Promise<void> {
    const { currentPassword, newPassword } = (body ?? {}) as Record<string, unknown>;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") throw new BadRequestException("invalid_request");
    await this.passwords.changeOwnPassword(currentPassword, newPassword);
  }
}
