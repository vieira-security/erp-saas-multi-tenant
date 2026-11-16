import { Inject, Injectable } from "@nestjs/common";
import type { BranchDto, BranchStatus, BranchSummaryDto, Page } from "@erp/contracts";
import { lockRowForAudit } from "../audit/audit-lock.js";
import { BusinessAuditWriter, auditActorOf } from "../audit/business-audit.js";
import { diffChanges } from "../audit/changes.js";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { BranchStatus as DbBranchStatus, CompanyStatus, Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../http/api-error.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { lockCompany } from "./company-lock.js";
import { BRANCH_SUMMARY_SELECT, toBranchDto, toBranchSummaryDto } from "./dto.js";
import { isRecordNotFound, isUniqueViolation } from "./prisma-errors.js";
import { cnpjRoot } from "./validation/cnpj.js";

/** Campos já normalizados/validados pelo controller (code em maiúsculo, CNPJ sem máscara, timezone canônico). */
export interface CreateBranchInput {
  companyId: string;
  name: string;
  code: string;
  cnpj?: string | null;
  timezone?: string;
}

export interface BranchChanges {
  name?: string;
  code?: string;
  cnpj?: string | null;
  timezone?: string;
}

/**
 * Filiais do tenant atual (TenantScope em toda query; outro tenant = 404). Regras do M3:
 * - CNPJ da filial, quando houver, tem a mesma raiz da Company (`cnpj_root_mismatch`);
 * - filial ACTIVE só sob Company ACTIVE (criar/ativar travam a Company com `FOR SHARE`, ver company-lock.ts);
 * - `code` e `cnpj` únicos por tenant (409).
 * KAN-41: `branch.*` com `branch_id` = a própria filial (o gerente com `audit.read` nela vê), na mesma transação;
 * idempotente sem mudança não audita.
 */
@Injectable()
export class BranchService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  async list(filter: { companyId?: string; status?: BranchStatus }, page: PageRequest): Promise<Page<BranchDto>> {
    const where = this.scope.where({
      ...(filter.companyId ? { companyId: filter.companyId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.branch.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: page.skip, take: page.take }),
      this.prisma.branch.count({ where }),
    ]);
    return toPage(rows, total, page, toBranchDto);
  }

  async get(id: string): Promise<BranchDto> {
    const branch = await this.prisma.branch.findUnique({ where: this.scope.where({ id }) });
    if (!branch) throw new NotFoundError("Branch");
    return toBranchDto(branch);
  }

  /** Filiais onde o usuário autenticado pode operar: com acesso, filial e empresa ACTIVE. */
  async listMine(): Promise<BranchSummaryDto[]> {
    const { userId } = this.auth.require();
    const rows = await this.prisma.userBranchAccess.findMany({
      where: this.scope.where({ userId, branch: { status: DbBranchStatus.ACTIVE, company: { status: CompanyStatus.ACTIVE } } }),
      select: { branch: { select: BRANCH_SUMMARY_SELECT } },
      orderBy: [{ branch: { createdAt: "asc" } }, { branchId: "asc" }],
    });
    return rows.map((row) => toBranchSummaryDto(row.branch));
  }

  async create(input: CreateBranchInput): Promise<BranchDto> {
    const tenantId = this.scope.tenantId();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const company = await lockCompany(tx, tenantId, input.companyId, "share");
        if (!company) throw new NotFoundError("Company");
        if (company.status !== CompanyStatus.ACTIVE) throw new ConflictError("company_inactive");
        const cnpj = input.cnpj ?? null;
        if (cnpj !== null && cnpjRoot(cnpj) !== cnpjRoot(company.cnpj)) throw new ValidationFailedError([{ field: "cnpj", issue: "cnpj_root_mismatch" }]);
        const branch = await tx.branch.create({
          data: this.scope.data({
            companyId: input.companyId,
            name: input.name,
            code: input.code,
            cnpj,
            status: DbBranchStatus.ACTIVE,
            timezone: input.timezone ?? company.timezone,
          }),
        });
        await new BusinessAuditWriter(tx, this.scope).record(auditActorOf(this.auth), {
          action: "branch.created",
          branchId: branch.id,
          companyId: branch.companyId,
          name: branch.name,
          code: branch.code,
          cnpj: branch.cnpj,
          timezone: branch.timezone,
        });
        return toBranchDto(branch);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.conflictFor({ code: input.code, cnpj: input.cnpj ?? null });
      throw error;
    }
  }

  /** Corpo vazio devolve o registro sem gravar. `companyId` e `status` não mudam por aqui. */
  async update(id: string, changes: BranchChanges): Promise<BranchDto> {
    const { name, code, cnpj, timezone } = changes;
    const data: Prisma.BranchUpdateInput = {
      ...(name !== undefined ? { name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(cnpj !== undefined ? { cnpj } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };
    if (Object.keys(data).length === 0) return this.get(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!(await lockRowForAudit(tx, "branches", this.scope.tenantId(), id))) throw new NotFoundError("Branch");
        const current = await tx.branch.findUnique({ where: this.scope.where({ id }) });
        if (!current) throw new NotFoundError("Branch");
        if (cnpj) {
          // CNPJ da Company é imutável pela API: não precisa de trava para comparar a raiz.
          const company = await tx.company.findUnique({ where: this.scope.where({ id: current.companyId }), select: { cnpj: true } });
          if (!company) throw new NotFoundError("Company");
          if (cnpjRoot(cnpj) !== cnpjRoot(company.cnpj)) throw new ValidationFailedError([{ field: "cnpj", issue: "cnpj_root_mismatch" }]);
        }
        const updated = await tx.branch.update({ where: this.scope.where({ id }), data });
        await new BusinessAuditWriter(tx, this.scope).record(auditActorOf(this.auth), {
          action: "branch.updated",
          branchId: id,
          changes: diffChanges(current, changes, ["name", "code", "cnpj", "timezone"]),
        });
        return toBranchDto(updated);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.conflictFor({ code: code ?? null, cnpj: cnpj ?? null }, id);
      if (isRecordNotFound(error)) throw new NotFoundError("Branch");
      throw error;
    }
  }

  /** Idempotente; não depende da Company. */
  async deactivate(id: string): Promise<BranchDto> {
    const actor = auditActorOf(this.auth);
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockRowForAudit(tx, "branches", this.scope.tenantId(), id))) throw new NotFoundError("Branch");
      const branch = await tx.branch.findUniqueOrThrow({ where: this.scope.where({ id }) });
      if (branch.status === DbBranchStatus.INACTIVE) return toBranchDto(branch);
      const updated = await tx.branch.update({ where: this.scope.where({ id }), data: { status: DbBranchStatus.INACTIVE } });
      await new BusinessAuditWriter(tx, this.scope).record(actor, { action: "branch.deactivated", branchId: id });
      return toBranchDto(updated);
    });
  }

  /** Idempotente; exige Company ACTIVE (travada até o commit). */
  async activate(id: string): Promise<BranchDto> {
    return this.prisma.$transaction(async (tx) => {
      // Filial travada antes da empresa (mesma ordem de lockBranchAndCompany): duas ativações simultâneas auditam uma vez.
      if (!(await lockRowForAudit(tx, "branches", this.scope.tenantId(), id))) throw new NotFoundError("Branch");
      const branch = await tx.branch.findUniqueOrThrow({ where: this.scope.where({ id }) });
      if (branch.status === DbBranchStatus.ACTIVE) return toBranchDto(branch);
      const company = await lockCompany(tx, this.scope.tenantId(), branch.companyId, "share");
      if (company?.status !== CompanyStatus.ACTIVE) throw new ConflictError("company_inactive");
      const updated = await tx.branch.update({ where: this.scope.where({ id }), data: { status: DbBranchStatus.ACTIVE } });
      await new BusinessAuditWriter(tx, this.scope).record(auditActorOf(this.auth), { action: "branch.activated", branchId: id });
      return toBranchDto(updated);
    });
  }

  /**
   * Qual unique foi violada: consulta o estado atual em vez de depender do formato de `meta` do Prisma/driver adapter.
   * Se nada conflitar mais (corrida em que o outro registro sumiu), devolve o conflito de código.
   */
  private async conflictFor(values: { code: string | null; cnpj: string | null }, exceptId?: string): Promise<ConflictError> {
    const others = exceptId ? { NOT: { id: exceptId } } : {};
    const taken = async (where: { code: string } | { cnpj: string }) =>
      (await this.prisma.branch.count({ where: this.scope.where({ ...where, ...others }) })) > 0;
    if (values.code && (await taken({ code: values.code }))) return new ConflictError("branch_code_already_exists");
    if (values.cnpj && (await taken({ cnpj: values.cnpj }))) return new ConflictError("branch_cnpj_already_exists");
    return new ConflictError("branch_code_already_exists");
  }
}
