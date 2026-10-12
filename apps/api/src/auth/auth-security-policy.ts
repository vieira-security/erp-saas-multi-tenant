import { DeviceStatus, TenantStatus } from "../generated/prisma/enums.js";

/**
 * Política de segurança do Auth, centralizada: nenhum número mágico espalhado pelo código. Os valores marcados
 * `DECISION REQUIRED` são defaults técnicos conservadores, ainda não aprovados pelo produto (docs/open-questions.md,
 * "Decisões pendentes do M2"); mudar aqui muda o comportamento de todo o Auth.
 */
export const AUTH_SECURITY_POLICY = Object.freeze({
  password: Object.freeze({
    /**
     * Limite em bytes UTF-8 de qualquer senha recebida (login, troca, reset). Protege o Argon2id contra entradas
     * absurdamente grandes (DoS); acima disso a senha é rejeitada antes de qualquer hash.
     */
    maxBytes: 1024,
    /** DECISION REQUIRED: comprimento mínimo de senha NOVA (troca/reset). Default técnico, sem outra regra de complexidade. */
    minLength: 8,
  }),
  lockout: Object.freeze({
    /** DECISION REQUIRED: falhas consecutivas de senha que disparam o bloqueio temporário (`locked_until`). */
    maxFailedAttempts: 5,
    /** DECISION REQUIRED: duração do bloqueio temporário. */
    durationMs: 15 * 60 * 1000,
  }),
  /**
   * DECISION REQUIRED: status de Tenant que permitem login, refresh e uso de sessão. `SUSPENDED` e `CANCELLED` bloqueiam;
   * `PAST_DUE` permanece liberado até haver regra de assinatura (não inventar cobrança no Auth).
   */
  tenantStatusesAllowed: Object.freeze([TenantStatus.TRIAL, TenantStatus.ACTIVE, TenantStatus.PAST_DUE] as const),
  /**
   * Status de Device que permitem criar, renovar e usar sessão. `REVOKED` nunca; `INACTIVE` ("fora de uso temporário")
   * também bloqueia, fail-closed (DECISION REQUIRED: confirmar a semântica de INACTIVE).
   */
  deviceStatusesAllowed: Object.freeze([DeviceStatus.ACTIVE] as const),
  /** Limites de entrada para identificadores do login (rejeitados antes de consultar o banco). */
  input: Object.freeze({
    maxEmployeeNumberLength: 64,
    maxDeviceKeyLength: 256,
    maxUserAgentLength: 512,
  }),
});

export type AuthSecurityPolicy = typeof AUTH_SECURITY_POLICY;

export function isTenantStatusAllowed(status: TenantStatus): boolean {
  return (AUTH_SECURITY_POLICY.tenantStatusesAllowed as readonly TenantStatus[]).includes(status);
}

export function isDeviceStatusAllowed(status: DeviceStatus): boolean {
  return (AUTH_SECURITY_POLICY.deviceStatusesAllowed as readonly DeviceStatus[]).includes(status);
}
