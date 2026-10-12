import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AUTH_CONFIG, loadAuthConfig } from "../config/auth-config.js";
import { AuthService } from "./auth.service.js";
import { AuthContextService } from "./context/auth-context.js";
import { AuthContextInterceptor } from "./http/auth-context.interceptor.js";
import { AuthExceptionFilter } from "./http/auth-exception.filter.js";
import { AuthController } from "./http/auth.controller.js";
import { AuthGuard } from "./http/auth.guard.js";
import { PasswordHasher } from "./password/password-hasher.js";
import { SessionService } from "./session.service.js";
import { AccessTokenService } from "./tokens/access-token.service.js";

/**
 * Autenticação. `AUTH_CONFIG` é lido do ambiente no boot (fail-fast). O AuthGuard é GLOBAL e o primeiro guard registrado:
 * toda rota exige autenticação, salvo `@Public()`. Global, como o TenancyModule: AuthContextService é transversal.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    PasswordHasher,
    AccessTokenService,
    AuthContextService,
    AuthService,
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuthContextInterceptor },
    { provide: APP_FILTER, useClass: AuthExceptionFilter },
  ],
  exports: [AUTH_CONFIG, PasswordHasher, AccessTokenService, AuthContextService, AuthService, SessionService],
})
export class AuthModule {}
