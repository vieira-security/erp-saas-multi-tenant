import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { BranchAccessDto, BranchDto, BranchSummaryDto, CompanyDto, MeDto, OrganizationDto, Page } from "@erp/contracts";
import { RequireBranchPermissions, RequirePermissions } from "../authorization/permission.guard.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID, checked, nullable, oneOf, optional, parseInput, required, text, uuid, type Parsed } from "../http/input.js";
import { pageQuerySpec, pageRequest } from "../http/paging.js";
import { BranchAccessService } from "./branch-access.service.js";
import { BranchService } from "./branch.service.js";
import { CompanyService } from "./company.service.js";
import { MeService } from "./me.service.js";
import { OrganizationService } from "./organization.service.js";
import { checkBranchCode } from "./validation/branch-code.js";
import { checkCnpj } from "./validation/cnpj.js";
import { checkTimezone } from "./validation/timezone.js";

/**
 * HTTP do M3 (contratos em `@erp/contracts`). Controllers só fazem parsing estrito + autorização declarativa por código de
 * permissão e delegam aos services. Rotas exigem autenticação (AuthGuard global); o tenant vem do token.
 */

// Limites publicados no contrato (ORGANIZATION_NAME_MAX_LENGTH, COMPANY_NAME_MAX_LENGTH, BRANCH_NAME_MAX_LENGTH).
const ORGANIZATION_NAME_MAX = 120;
const COMPANY_NAME_MAX = 200;
const BRANCH_NAME_MAX = 120;

const cnpj = checked((value): Parsed<string> => {
  const result = checkCnpj(value);
  return result.ok ? result : { ok: false, issue: result.issue };
});
const timezone = checked((value): Parsed<string> => {
  const result = checkTimezone(value);
  return result.ok ? result : { ok: false, issue: "invalid_timezone" };
});
const branchCode = checked((value): Parsed<string> => checkBranchCode(value));
const STATUSES = ["ACTIVE", "INACTIVE"] as const;

/** Id de rota fora do formato UUID = recurso inexistente (404), sem consultar o banco. */
function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

interface StatusResponse {
  status(code: number): unknown;
}

@Controller("organization")
export class OrganizationController {
  constructor(@Inject(OrganizationService) private readonly organization: OrganizationService) {}

  @Get()
  @RequirePermissions("organization.read")
  get(): Promise<OrganizationDto> {
    return this.organization.get();
  }

  @Patch()
  @RequirePermissions("organization.manage")
  update(@Body() body: unknown): Promise<OrganizationDto> {
    return this.organization.update(parseInput(body, { name: optional(text(ORGANIZATION_NAME_MAX)) }));
  }
}

@Controller("companies")
export class CompaniesController {
  constructor(@Inject(CompanyService) private readonly companies: CompanyService) {}

  @Get()
  @RequirePermissions("organization.read")
  list(@Query() query: unknown): Promise<Page<CompanyDto>> {
    const { status, ...paging } = parseInput(query, { ...pageQuerySpec, status: optional(oneOf(STATUSES)) }, "query");
    return this.companies.list(status ? { status } : {}, pageRequest(paging));
  }

  @Get(":companyId")
  @RequirePermissions("organization.read")
  get(@Param("companyId") companyId: string): Promise<CompanyDto> {
    return this.companies.get(routeId(companyId, "Company"));
  }

  @Post()
  @RequirePermissions("organization.manage")
  create(@Body() body: unknown): Promise<CompanyDto> {
    const input = parseInput(body, {
      legalName: required(text(COMPANY_NAME_MAX)),
      tradeName: required(text(COMPANY_NAME_MAX)),
      cnpj: required(cnpj),
      timezone: required(timezone),
    });
    return this.companies.create(input);
  }

  @Patch(":companyId")
  @RequirePermissions("organization.manage")
  update(@Param("companyId") companyId: string, @Body() body: unknown): Promise<CompanyDto> {
    const id = routeId(companyId, "Company");
    const changes = parseInput(body, {
      legalName: optional(text(COMPANY_NAME_MAX)),
      tradeName: optional(text(COMPANY_NAME_MAX)),
      timezone: optional(timezone),
    });
    return this.companies.update(id, changes);
  }

  @Post(":companyId/deactivate")
  @HttpCode(200)
  @RequirePermissions("organization.manage")
  deactivate(@Param("companyId") companyId: string): Promise<CompanyDto> {
    return this.companies.deactivate(routeId(companyId, "Company"));
  }

  @Post(":companyId/activate")
  @HttpCode(200)
  @RequirePermissions("organization.manage")
  activate(@Param("companyId") companyId: string): Promise<CompanyDto> {
    return this.companies.activate(routeId(companyId, "Company"));
  }
}

@Controller("branches")
export class BranchesController {
  constructor(@Inject(BranchService) private readonly branches: BranchService) {}

  @Get()
  @RequirePermissions("branch.read")
  list(@Query() query: unknown): Promise<Page<BranchDto>> {
    const { status, companyId, ...paging } = parseInput(
      query,
      { ...pageQuerySpec, status: optional(oneOf(STATUSES)), companyId: optional(uuid) },
      "query",
    );
    return this.branches.list({ ...(status ? { status } : {}), ...(companyId ? { companyId } : {}) }, pageRequest(paging));
  }

  @Get(":branchId")
  @RequirePermissions("branch.read")
  get(@Param("branchId") branchId: string): Promise<BranchDto> {
    return this.branches.get(routeId(branchId, "Branch"));
  }

  @Post()
  @RequirePermissions("branch.manage")
  create(@Body() body: unknown): Promise<BranchDto> {
    const input = parseInput(body, {
      companyId: required(uuid),
      name: required(text(BRANCH_NAME_MAX)),
      code: required(branchCode),
      cnpj: optional(nullable(cnpj)),
      timezone: optional(timezone),
    });
    return this.branches.create(input);
  }

  @Patch(":branchId")
  @RequirePermissions("branch.manage")
  update(@Param("branchId") branchId: string, @Body() body: unknown): Promise<BranchDto> {
    const id = routeId(branchId, "Branch");
    const changes = parseInput(body, {
      name: optional(text(BRANCH_NAME_MAX)),
      code: optional(branchCode),
      cnpj: optional(nullable(cnpj)),
      timezone: optional(timezone),
    });
    return this.branches.update(id, changes);
  }

  @Post(":branchId/deactivate")
  @HttpCode(200)
  @RequirePermissions("branch.manage")
  deactivate(@Param("branchId") branchId: string): Promise<BranchDto> {
    return this.branches.deactivate(routeId(branchId, "Branch"));
  }

  @Post(":branchId/activate")
  @HttpCode(200)
  @RequirePermissions("branch.manage")
  activate(@Param("branchId") branchId: string): Promise<BranchDto> {
    return this.branches.activate(routeId(branchId, "Branch"));
  }
}

/**
 * Dados do próprio usuário autenticado; sem permissão específica (só autenticação). Com troca de senha obrigatória, o
 * AuthGuard responde 403 `password_change_required` como em qualquer rota de negócio (sem exceção aqui).
 */
@Controller("me")
export class MeController {
  constructor(
    @Inject(BranchService) private readonly branches: BranchService,
    @Inject(MeService) private readonly me: MeService,
  ) {}

  /** KAN-52: usuário, organização e permissões efetivas no tenant e em cada filial com acesso (MeDto). */
  @Get()
  get(): Promise<MeDto> {
    return this.me.get();
  }

  @Get("branches")
  myBranches(): Promise<BranchSummaryDto[]> {
    return this.branches.listMine();
  }
}

@Controller("users/:userId/branch-access")
export class BranchAccessController {
  constructor(@Inject(BranchAccessService) private readonly access: BranchAccessService) {}

  @Get()
  @RequirePermissions("user.read")
  list(@Param("userId") userId: string): Promise<BranchAccessDto[]> {
    return this.access.list(routeId(userId, "User"));
  }

  /** `user.manage` NA filial alvo: o guard exige acesso do ator àquela filial (filial de outro tenant/inexistente = 403). */
  @Put(":branchId")
  @RequireBranchPermissions("branchId", "user.manage")
  async grant(
    @Param("userId") userId: string,
    @Param("branchId") branchId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<BranchAccessDto> {
    const result = await this.access.grant(routeId(userId, "User"), routeId(branchId, "Branch"));
    response.status(result.created ? 201 : 200);
    return result.access;
  }

  @Delete(":branchId")
  @HttpCode(204)
  @RequireBranchPermissions("branchId", "user.manage")
  async revoke(@Param("userId") userId: string, @Param("branchId") branchId: string): Promise<void> {
    await this.access.revoke(routeId(userId, "User"), routeId(branchId, "Branch"));
  }
}
