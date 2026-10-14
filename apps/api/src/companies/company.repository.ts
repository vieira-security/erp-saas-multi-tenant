import { Prisma, type Company, type CompanyStatus, type PrismaClient } from "../generated/prisma/client.js";
import type { TenantScope } from "../tenancy/tenant-scope.js";

/** Campos de negócio para criar uma Company. Sem `tenantId`: o tenant vem só do TenantContext. */
export interface NewCompany {
  legalName: string;
  tradeName: string;
  cnpj: string;
  status: CompanyStatus;
  timezone: string;
}

/** Campos alteráveis. Sem `tenantId` (imutável no banco) e sem `cnpj` nesta prova. */
export interface CompanyChanges {
  legalName?: string;
  tradeName?: string;
  status?: CompanyStatus;
  timezone?: string;
}

/** PrismaClient ou o client de uma transação interativa (`prisma.$transaction(async (tx) => ...)`). */
export type CompanyDb = Pick<PrismaClient, "company">;

/**
 * Primeiro repository tenant-scoped e prova do padrão de data access (docs/architecture.md): toda query passa por
 * TenantScope, então só enxerga e altera Companies do tenant atual. Sem DELETE: `erp_app` não tem esse privilégio
 * (Company é desativada por status). Métodos `async`: falta de contexto sempre vira Promise rejeitada.
 */
export class CompanyRepository {
  constructor(
    private readonly db: CompanyDb,
    private readonly scope: TenantScope,
  ) {}

  /** Cria no tenant do contexto. Só os campos de NewCompany são lidos: um `tenantId` contrabandeado é ignorado. */
  async create(input: NewCompany): Promise<Company> {
    const { legalName, tradeName, cnpj, status, timezone } = input;
    return this.db.company.create({ data: this.scope.data({ legalName, tradeName, cnpj, status, timezone }) });
  }

  /** Company do tenant atual com este id; `null` se não existir ou for de outro tenant. */
  async findById(id: string): Promise<Company | null> {
    return this.db.company.findUnique({ where: this.scope.where({ id }) });
  }

  /** Companies do tenant atual, em ordem de criação. */
  async list(): Promise<Company[]> {
    return this.db.company.findMany({ where: this.scope.where({}), orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  }

  /** Altera uma Company do tenant atual; `null` (sem alteração alguma) se não existir ou for de outro tenant. */
  async update(id: string, changes: CompanyChanges): Promise<Company | null> {
    const { legalName, tradeName, status, timezone } = changes;
    const data: Prisma.CompanyUpdateInput = {};
    if (legalName !== undefined) data.legalName = legalName;
    if (tradeName !== undefined) data.tradeName = tradeName;
    if (status !== undefined) data.status = status;
    if (timezone !== undefined) data.timezone = timezone;
    try {
      return await this.db.company.update({ where: this.scope.where({ id }), data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return null;
      throw error;
    }
  }
}
