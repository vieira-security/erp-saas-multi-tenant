import { Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { SessionService } from "../session.service.js";
import { AllowWhenPasswordChangeRequired } from "./auth-decorators.js";

/**
 * Transporte HTTP mínimo do Auth: só operações que dependem apenas do access token (Bearer). Login e refresh NÃO têm
 * endpoint: dependem da descoberta do tenant pré-login e do transporte do refresh token (cookie HttpOnly x corpo),
 * ambos DECISION REQUIRED. Controller sem regra de negócio: delega aos services.
 */
@Controller("auth")
export class AuthController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  /** Encerra a sessão do access token apresentado. Idempotente: 204 sempre que autenticado. */
  @Post("logout")
  @HttpCode(204)
  @AllowWhenPasswordChangeRequired()
  async logout(): Promise<void> {
    await this.sessions.logout();
  }
}
