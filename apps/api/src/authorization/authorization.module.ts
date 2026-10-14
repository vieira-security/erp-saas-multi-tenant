import { Global, Module } from "@nestjs/common";
import { AuthorizationService } from "./authorization.service.js";

/** Resolução de permissões efetivas. O PermissionGuard é registrado pelo AuthModule, logo após o AuthGuard (ordem fixa). */
@Global()
@Module({ providers: [AuthorizationService], exports: [AuthorizationService] })
export class AuthorizationModule {}
