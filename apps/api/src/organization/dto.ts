import type { BranchAccessDto, BranchDto, BranchSummaryDto, CompanyDto, OrganizationDto } from "@erp/contracts";
import type { Branch, Company, Tenant, UserBranchAccess } from "../generated/prisma/client.js";

/** Model Prisma -> contrato HTTP. Só campos do contrato: `tenantId` nunca sai. */

export function toOrganizationDto(tenant: Tenant): OrganizationDto {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    loginCode: tenant.loginCode,
    trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

export function toCompanyDto(company: Company): CompanyDto {
  return {
    id: company.id,
    legalName: company.legalName,
    tradeName: company.tradeName,
    cnpj: company.cnpj,
    status: company.status,
    timezone: company.timezone,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

export function toBranchDto(branch: Branch): BranchDto {
  return {
    id: branch.id,
    companyId: branch.companyId,
    name: branch.name,
    code: branch.code,
    cnpj: branch.cnpj,
    status: branch.status,
    timezone: branch.timezone,
    createdAt: branch.createdAt.toISOString(),
    updatedAt: branch.updatedAt.toISOString(),
  };
}

export type BranchSummaryRow = Pick<Branch, "id" | "companyId" | "name" | "code" | "status">;

/** `select` do Prisma correspondente a BranchSummaryDto. */
export const BRANCH_SUMMARY_SELECT = { id: true, companyId: true, name: true, code: true, status: true } as const;

export function toBranchSummaryDto(branch: BranchSummaryRow): BranchSummaryDto {
  return { id: branch.id, companyId: branch.companyId, name: branch.name, code: branch.code, status: branch.status };
}

export function toBranchAccessDto(access: Pick<UserBranchAccess, "userId" | "branchId" | "createdAt"> & { branch: BranchSummaryRow }): BranchAccessDto {
  return {
    userId: access.userId,
    branchId: access.branchId,
    createdAt: access.createdAt.toISOString(),
    branch: toBranchSummaryDto(access.branch),
  };
}
