import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import type { Page, UserDto, UserSummaryDto } from "@erp/contracts";
import { RequirePermissions } from "../authorization/permission.guard.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID } from "../http/input.js";
import { parseListUsersQuery } from "./list-users-query.js";
import { UserService } from "./user.service.js";

/** Id de rota fora do formato UUID = recurso inexistente (404), sem consultar o banco. */
function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

/**
 * Leitura de funcionários (contrato `packages/contracts/src/users.ts`, KAN-29). `users/:userId/branch-access` continua
 * no OrganizationModule (M3); este controller só tem as leituras do próprio usuário e fica no módulo `users`, onde o
 * cadastro de funcionários vai entrar.
 */
@Controller("users")
export class UsersController {
  constructor(@Inject(UserService) private readonly users: UserService) {}

  @Get()
  @RequirePermissions("user.read")
  list(@Query() query: unknown): Promise<Page<UserSummaryDto>> {
    const { filter, page } = parseListUsersQuery(query);
    return this.users.list(filter, page);
  }

  @Get(":userId")
  @RequirePermissions("user.read")
  get(@Param("userId") userId: string): Promise<UserDto> {
    return this.users.get(routeId(userId, "User"));
  }
}
