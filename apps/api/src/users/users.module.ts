import { Module } from "@nestjs/common";
import { UserService } from "./user.service.js";
import { UsersController } from "./users.controller.js";

/**
 * Funcionários: por enquanto só leitura (`GET /users`, `GET /users/:userId`). Erros `ApiError` -> `{ error, details? }`
 * pelo ApiExceptionFilter global (registrado no OrganizationModule).
 */
@Module({ controllers: [UsersController], providers: [UserService] })
export class UsersModule {}
