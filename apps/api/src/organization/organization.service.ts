import { Inject, Injectable } from "@nestjs/common";
import type { OrganizationDto } from "@erp/contracts";
import { lockTenantForAudit } from "../audit/audit-lock.js";
import { BusinessAuditWriter, auditActorOf } from "../audit/business-audit.js";
import { diffChanges } from "../audit/changes.js";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { toOrganizationDto } from "./dto.js";

/**
 * A organização é o Tenant (model `root`, sem `tenant_id`). Nunca recebe id do cliente: lê e altera SÓ o tenant do
 * contexto autenticado (`scope.tenantId()`). Só `name` é alterável aqui; status, login_code e trial são de billing/SaaS.
 * KAN-41: `organization.updated` (sem filial) na mesma transação, só quando o nome muda de fato.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  async get(): Promise<OrganizationDto> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: this.scope.tenantId() } });
    if (!tenant) throw new NotFoundError("Tenant");
    return toOrganizationDto(tenant);
  }

  async update(changes: { name?: string }): Promise<OrganizationDto> {
    const { name } = changes;
    if (name === undefined) return this.get();
    const actor = auditActorOf(this.auth);
    const tenantId = this.scope.tenantId();
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockTenantForAudit(tx, tenantId))) throw new NotFoundError("Tenant");
      const before = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
      const tenant = await tx.tenant.update({ where: { id: tenantId }, data: { name } });
      await new BusinessAuditWriter(tx, this.scope).record(actor, {
        action: "organization.updated",
        tenantId,
        changes: diffChanges(before, { name }, ["name"]),
      });
      return toOrganizationDto(tenant);
    });
  }
}
