import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import type { Page, UserDto, UserSummaryDto } from "@erp/contracts";
import { RequirePermissions } from "../authorization/permission.guard.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID } from "../http/input.js";
import { parseListUsersQuery } from "./list-users-query.js";
import { UserManagementService } from "./user-management.service.js";
import { parseCreateUser, parseReplaceRoles, parseResetPassword, parseUpdateUser } from "./user-requests.js";
import { UserService } from "./user.service.js";

/** Id de rota fora do formato UUID = recurso inexistente (404), sem consultar o banco. */
function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

/**
 * Funcionários (contrato `packages/contracts/src/users.ts`): leitura (KAN-29) e gestão. `users/:userId/branch-access`
 * continua no OrganizationModule (M3). Toda gestão exige `user.manage` no tenant; a autoridade sobre o alvo e sobre as
 * roles é conferida no UserManagementService.
 */
@Controller("users")
export class UsersController {
  constructor(
    @Inject(UserService) private readonly users: UserService,
    @Inject(UserManagementService) private readonly management: UserManagementService,
  ) {}

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

  @Post()
  @RequirePermissions("user.manage")
  create(@Body() body: unknown): Promise<UserDto> {
    return this.management.create(parseCreateUser(body));
  }

  @Patch(":userId")
  @RequirePermissions("user.manage")
  update(@Param("userId") userId: string, @Body() body: unknown): Promise<UserDto> {
    const id = routeId(userId, "User");
    return this.management.rename(id, parseUpdateUser(body).name);
  }

  @Put(":userId/roles")
  @RequirePermissions("user.manage")
  replaceRoles(@Param("userId") userId: string, @Body() body: unknown): Promise<UserDto> {
    const id = routeId(userId, "User");
    return this.management.replaceRoles(id, parseReplaceRoles(body));
  }

  @Post(":userId/deactivate")
  @HttpCode(200)
  @RequirePermissions("user.manage")
  deactivate(@Param("userId") userId: string): Promise<UserDto> {
    return this.management.deactivate(routeId(userId, "User"));
  }

  @Post(":userId/activate")
  @HttpCode(200)
  @RequirePermissions("user.manage")
  activate(@Param("userId") userId: string): Promise<UserDto> {
    return this.management.activate(routeId(userId, "User"));
  }

  @Post(":userId/reset-password")
  @HttpCode(200)
  @RequirePermissions("user.manage")
  resetPassword(@Param("userId") userId: string, @Body() body: unknown): Promise<UserDto> {
    const id = routeId(userId, "User");
    return this.management.resetPassword(id, parseResetPassword(body).temporaryPassword);
  }

  @Post(":userId/unlock")
  @HttpCode(200)
  @RequirePermissions("user.manage")
  unlock(@Param("userId") userId: string): Promise<UserDto> {
    return this.management.unlock(routeId(userId, "User"));
  }
}
