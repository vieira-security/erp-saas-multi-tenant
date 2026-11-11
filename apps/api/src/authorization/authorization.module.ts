import { Global, Module } from "@nestjs/common";
import { AuthorityService } from "./authority.js";
import { AuthorizationService } from "./authorization.service.js";

/** Resolução de permissões efetivas e a regra de autoridade (AuthorityService). O PermissionGuard é registrado pelo AuthModule, logo após o AuthGuard (ordem fixa). */
@Global()
@Module({ providers: [AuthorizationService, AuthorityService], exports: [AuthorizationService, AuthorityService] })
export class AuthorizationModule {}
