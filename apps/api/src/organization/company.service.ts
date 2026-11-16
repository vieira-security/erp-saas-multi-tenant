import { Inject, Injectable } from "@nestjs/common";
import type { CompanyDto, CompanyStatus, Page } from "@erp/contracts";
import { lockRowForAudit } from "../audit/audit-lock.js";
import { BusinessAuditWriter, auditActorOf } from "../audit/business-audit.js";
import { diffChanges } from "../audit/changes.js";
import { AuthContextService } from "../auth/context/auth-context.js";
import { CompanyRepository, type CompanyChanges } from "../companies/company.repository.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { BranchStatus, CompanyStatus as DbCompanyStatus, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../http/api-error.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { lockCompany } from "./company-lock.js";
import { toCompanyDto } from "./dto.js";
import { isUniqueViolation } from "./prisma-errors.js";

export interface CreateCompanyInput {
  legalName: string;
  tradeName: string;
  /** Já normalizado e validado (14 caracteres). */
  cnpj: string;
  /** Já canônico (IANA). */
  timezone: string;
}

/**
 * Companies do tenant atual. Tudo passa por TenantScope (direto ou via CompanyRepository); recurso de outro tenant é
 * indistinguível de inexistente (404). Sem exclusão: só status.
 * KAN-41: `company.*` (eventos do tenant, sem filial) na mesma transação; idempotente sem mudança não audita.
 */
@Injectable()
export class CompanyService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  private repository(): CompanyRepository {
    return new CompanyRepository(this.prisma, this.scope);
  }

  async list(filter: { status?: CompanyStatus }, page: PageRequest): Promise<Page<CompanyDto>> {
    const where = this.scope.where(filter.status ? { status: filter.status } : {});
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.company.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: page.skip, take: page.take }),
      this.prisma.company.count({ where }),
    ]);
    return toPage(rows, total, page, toCompanyDto);
  }

  async get(id: string): Promise<CompanyDto> {
    const company = await this.repository().findById(id);
    if (!company) throw new NotFoundError("Company");
    return toCompanyDto(company);
  }

  async create(input: CreateCompanyInput): Promise<CompanyDto> {
    const actor = auditActorOf(this.auth);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const company = await new CompanyRepository(tx, this.scope).create({ ...input, status: DbCompanyStatus.ACTIVE });
        await new BusinessAuditWriter(tx, this.scope).record(actor, {
          action: "company.created",
          companyId: company.id,
          legalName: company.legalName,
          tradeName: company.tradeName,
          cnpj: company.cnpj,
          timezone: company.timezone,
        });
        return toCompanyDto(company);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("company_cnpj_already_exists");
      throw error;
    }
  }

  /** Corpo vazio devolve o registro sem gravar (não mexe em `updated_at`). */
  async update(id: string, changes: Omit<CompanyChanges, "status">): Promise<CompanyDto> {
    const { legalName, tradeName, timezone } = changes;
    const data: Omit<CompanyChanges, "status"> = {
      ...(legalName !== undefined ? { legalName } : {}),
      ...(tradeName !== undefined ? { tradeName } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };
    if (Object.keys(data).length === 0) return this.get(id);
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRowForAudit(tx, "companies", this.scope.tenantId(), id))) throw new NotFoundError("Company");
      const repository = new CompanyRepository(tx, this.scope);
      const before = await repository.findById(id);
      const company = await repository.update(id, data);
      if (!before || !company) throw new NotFoundError("Company");
      await new BusinessAuditWriter(tx, this.scope).record(actor, {
        action: "company.updated",
        companyId: id,
        changes: diffChanges(before, data, ["legalName", "tradeName", "timezone"]),
      });
      return toCompanyDto(company);
    });
  }

  /** Só desativa sem filial ACTIVE (decisão conservadora do M3, ver docs/open-questions.md). Idempotente. */
  async deactivate(id: string): Promise<CompanyDto> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockCompany(tx, this.scope.tenantId(), id, "update");
      if (!locked) throw new NotFoundError("Company");
      if (locked.status !== DbCompanyStatus.INACTIVE) {
        const activeBranches = await tx.branch.count({ where: this.scope.where({ companyId: id, status: BranchStatus.ACTIVE }) });
        if (activeBranches > 0) throw new ConflictError("company_has_active_branches");
        await new CompanyRepository(tx, this.scope).update(id, { status: DbCompanyStatus.INACTIVE });
        await new BusinessAuditWriter(tx, this.scope).record(auditActorOf(this.auth), { action: "company.deactivated", companyId: id });
      }
      return toCompanyDto((await new CompanyRepository(tx, this.scope).findById(id))!);
    });
  }

  /** Idempotente. */
  async activate(id: string): Promise<CompanyDto> {
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockCompany(tx, this.scope.tenantId(), id, "update");
      if (!locked) throw new NotFoundError("Company");
      const repository = new CompanyRepository(tx, this.scope);
      if (locked.status !== DbCompanyStatus.ACTIVE) {
        await repository.update(id, { status: DbCompanyStatus.ACTIVE });
        await new BusinessAuditWriter(tx, this.scope).record(actor, { action: "company.activated", companyId: id });
      }
      return toCompanyDto((await repository.findById(id))!);
    });
  }
}
