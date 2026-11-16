import type {
  BranchDto,
  BranchSummaryDto,
  CompanyDto,
  ListBranchesQuery,
  ListCompaniesQuery,
  MeDto,
  OrganizationDto,
  Page,
} from "@erp/contracts";
import type { HttpClient, RequestOptions } from "./http-client";

/**
 * Rotas da API usadas pelo web. Tipos de request/response SÓ de `@erp/contracts` (não redefinir aqui). Nenhuma rota
 * recebe tenant: ele vem do token. Filial, quando existe, vai no caminho (`/branches/:branchId/...`).
 */
export interface ErpApi {
  /** `GET /me` — usuário, organização, permissões do tenant e por filial (só para montar a interface). */
  me(options?: RequestOptions): Promise<MeDto>;
  /** `GET /me/branches` — filiais operáveis, para o seletor. */
  myBranches(options?: RequestOptions): Promise<readonly BranchSummaryDto[]>;
  /** `GET /organization` (`organization.read`). */
  organization(options?: RequestOptions): Promise<OrganizationDto>;
  /** `GET /companies` (`organization.read`), paginado. */
  companies(query?: ListCompaniesQuery, options?: RequestOptions): Promise<Page<CompanyDto>>;
  /** `GET /branches` (`branch.read`), paginado. */
  branches(query?: ListBranchesQuery, options?: RequestOptions): Promise<Page<BranchDto>>;
}

export function createErpApi(client: HttpClient): ErpApi {
  return {
    me: (options) => client.request<MeDto>("GET", "/me", options),
    myBranches: (options) => client.request<readonly BranchSummaryDto[]>("GET", "/me/branches", options),
    organization: (options) => client.request<OrganizationDto>("GET", "/organization", options),
    companies: (query = {}, options = {}) =>
      client.request<Page<CompanyDto>>("GET", "/companies", { ...options, query: { ...query } }),
    branches: (query = {}, options = {}) =>
      client.request<Page<BranchDto>>("GET", "/branches", { ...options, query: { ...query } }),
  };
}
