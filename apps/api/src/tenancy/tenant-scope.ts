import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { TenantContextService } from "./tenant-context.js";

export type ModelScope = "root" | "global" | "tenant";

/**
 * Classificação de data access de todo model (a mesma das tabelas no M1, docs/database.md). `satisfies` faz o
 * typecheck falhar se um model novo não for classificado. Só `tenant` passa por TenantScope:
 * - root (`Tenant`): administração do próprio tenant/SaaS, sem `tenant_id`; nunca recebe filtro implícito;
 * - global (`Permission`): catálogo compartilhado, sem `tenant_id`; não exige TenantContext.
 */
export const MODEL_SCOPE = {
  Tenant: "root",
  Permission: "global",
  Company: "tenant",
  Branch: "tenant",
  User: "tenant",
  UserBranchAccess: "tenant",
  Role: "tenant",
  RolePermission: "tenant",
  UserRole: "tenant",
  Device: "tenant",
  Session: "tenant",
  AuditLog: "tenant",
} as const satisfies Record<Prisma.ModelName, ModelScope>;

/** Input de escopo: quem chama nunca informa o tenant (nem `tenantId`, nem a relação `tenant`). */
type WithoutTenant = { tenantId?: never; tenant?: never };

/** `where`/`data` que tentaram definir o tenant por conta própria: bug de quem chama, nunca tratado como válido. */
export class TenantScopeViolationError extends Error {
  override readonly name = "TenantScopeViolationError";
  constructor(part: "where" | "data") {
    super(`Tenant-scoped ${part} must not set tenantId/tenant: the tenant comes only from TenantContext`);
  }
}

function assertNoTenant(value: object, part: "where" | "data"): void {
  if (Object.hasOwn(value, "tenantId") || Object.hasOwn(value, "tenant")) throw new TenantScopeViolationError(part);
}

/**
 * Padrão obrigatório de data access para models `tenant` (MODEL_SCOPE): o tenant vem SEMPRE do TenantContext atual
 * e entra em toda query. Explícito de propósito (sem Prisma extension que reescreva queries):
 *
 *   findUnique/findFirst/findMany/count: where: scope.where({ id })      -> WHERE tenant_id = $ctx AND id = ...
 *   update/delete (unique):              where: scope.where({ id })      -> registro de outro tenant = não encontrado
 *   updateMany/deleteMany:               where: scope.where({ ... })
 *   create:                              data:  scope.data({ ...campos }) -> tenant_id = $ctx
 *
 * Nunca usar só o `id` (UUID globalmente único não substitui o filtro de tenant). Filtros de relação (`some`,
 * `include`) entre tabelas de tenant ficam no mesmo tenant pelas FKs compostas do M1. Sem contexto, lança
 * TenantContextMissingError antes de qualquer query.
 */
@Injectable()
export class TenantScope {
  constructor(private readonly context: TenantContextService) {}

  /** Tenant atual (exige contexto). */
  tenantId(): string {
    return this.context.requireTenantId();
  }

  /** `where` + `tenantId` do contexto (campos de topo do Prisma são combinados com AND, inclusive `OR`/`NOT`). */
  where<W extends object & WithoutTenant>(where: W): W & { tenantId: string } {
    assertNoTenant(where, "where");
    return { ...where, tenantId: this.context.requireTenantId() };
  }

  /** `data` de create + `tenantId` do contexto. Para update, não usar: `tenant_id` é imutável. */
  data<D extends object & WithoutTenant>(data: D): D & { tenantId: string } {
    assertNoTenant(data, "data");
    return { ...data, tenantId: this.context.requireTenantId() };
  }
}
