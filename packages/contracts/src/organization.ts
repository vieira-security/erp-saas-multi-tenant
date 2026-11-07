/**
 * Organização = o Tenant autenticado (cliente SaaS). Só existe "a minha organização": não há id na rota.
 *
 * GET   /organization   permissão `organization.read`   -> 200 OrganizationDto
 * PATCH /organization   permissão `organization.manage` -> 200 OrganizationDto
 *
 * `status`, `loginCode` e datas de trial NÃO são alteráveis aqui (billing/administração SaaS).
 */

export const TENANT_STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export interface OrganizationDto {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
  /** Código público usado na tela de login; `null` = sem login por código. */
  readonly loginCode: string | null;
  readonly trialEndsAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateOrganizationRequest {
  /** 1–120 caracteres após trim. */
  readonly name?: string;
}

export const ORGANIZATION_NAME_MAX_LENGTH = 120;
