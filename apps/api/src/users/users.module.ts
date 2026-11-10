import { Module } from "@nestjs/common";
import { UserManagementService } from "./user-management.service.js";
import { UserService } from "./user.service.js";
import { UsersController } from "./users.controller.js";

/**
 * Funcionários: leitura (`GET /users`, `GET /users/:userId`) e gestão (cadastro, nome, roles, desativar/ativar, reset
 * de senha, desbloqueio). Erros `ApiError` -> `{ error, details? }`
 * pelo ApiExceptionFilter global (registrado no OrganizationModule).
 */
@Module({ controllers: [UsersController], providers: [UserService, UserManagementService] })
export class UsersModule {}
