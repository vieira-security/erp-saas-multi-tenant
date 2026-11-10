import { Inject, Injectable } from "@nestjs/common";
import type { OrganizationDto } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toOrganizationDto } from "./dto.js";

/**
 * A organização é o Tenant (model `root`, sem `tenant_id`). Nunca recebe id do cliente: lê e altera SÓ o tenant do
 * contexto autenticado (`scope.tenantId()`). Só `name` é alterável aqui; status, login_code e trial são de billing/SaaS.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  async get(): Promise<OrganizationDto> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: this.scope.tenantId() } });
    if (!tenant) throw new NotFoundError("Tenant");
    return toOrganizationDto(tenant);
  }

  async update(changes: { name?: string }): Promise<OrganizationDto> {
    if (changes.name === undefined) return this.get();
    const tenant = await this.prisma.tenant.update({ where: { id: this.scope.tenantId() }, data: { name: changes.name } });
    return toOrganizationDto(tenant);
  }
}
