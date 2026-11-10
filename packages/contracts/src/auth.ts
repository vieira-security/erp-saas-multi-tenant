/**
 * Autenticação (M2) — rotas que JÁ EXISTEM na API, registradas aqui para o frontend. Regras de segurança (CLAUDE.md):
 * - access token só em memória, enviado como `Authorization: Bearer <accessToken>`; nunca `localStorage`;
 * - refresh token só no cookie `HttpOnly; SameSite=Strict; Path=/auth` (nome `erp_rt`, ou `__Secure-erp_rt` com Secure),
 *   rotacionado a cada uso; o frontend nunca lê nem envia o refresh token manualmente;
 * - login, refresh e logout conferem o header `Origin` (lista `AUTH_ALLOWED_ORIGINS` da API): fora dela -> 403
 *   `forbidden_origin`. Em dev, web e API precisam parecer o mesmo site (proxy do Next, KAN-53);
 * - não existe header de tenant nem de filial: o tenant vem do token; a filial vem da rota (`/branches/:branchId/...`).
 *
 * POST /auth/login     público  LoginRequest -> 200 AccessTokenResponse + cookie
 *                      401 invalid_credentials (genérico: matrícula/senha/código errados, usuário bloqueado temporariamente
 *                      ou desativado não são distinguidos) | 403 tenant_unavailable | 403 device_not_allowed | 403 forbidden_origin
 * POST /auth/refresh   público, só cookie -> 200 AccessTokenResponse + cookie novo | 401 unauthenticated (cookie limpo)
 * POST /auth/logout    público, só cookie -> 204 sempre (cookie limpo)
 * POST /auth/password  Bearer (aceito mesmo com troca obrigatória) ChangePasswordRequest -> 204 (outras sessões revogadas)
 *                      403 invalid_current_password | 400 password_policy_violation
 *
 * Corpo fora do formato em /auth/login e /auth/password (não-objeto, campo obrigatório ausente, valor não-string, campo
 * desconhecido) -> 400 `{ error: "validation_failed", details: [{ field, issue }] }` (mesmo `ApiErrorResponse` das demais
 * rotas; `issue` = `required` | `invalid_type` | `unknown_field`; `field = "body"` quando o corpo não é objeto). Os
 * valores nunca são ecoados. Strings não são aparadas aqui: a senha vale como digitada; matrícula e código são normalizados
 * pela API (fora do formato = 401 `invalid_credentials`, não 400).
 *
 * Com `mustChangePassword: true`, toda rota de negócio responde 403 `password_change_required` até a troca de senha.
 * Qualquer rota com Bearer inválido/expirado responde 401 `unauthenticated`: chame `/auth/refresh` e repita uma vez.
 */

export const AUTH_ERROR_CODES = [
  "validation_failed",
  "invalid_credentials",
  "unauthenticated",
  "tenant_unavailable",
  "device_not_allowed",
  "forbidden_origin",
  "password_change_required",
  "invalid_current_password",
  "password_policy_violation",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export interface LoginRequest {
  /** Código público da organização (ex.: `DEMO`). */
  readonly loginCode: string;
  /** Matrícula; a API faz trim + maiúsculo. */
  readonly employeeNumber: string;
  readonly password: string;
  /** Identificador do dispositivo (PDV), opcional. Não é segredo. */
  readonly deviceKey?: string;
}

export interface AccessTokenResponse {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  /** Expiração do access token (curto, ~15 min). Renove antes com `/auth/refresh`. */
  readonly accessTokenExpiresAt: string;
  /** Fim absoluto da sessão (12 h); depois disso só com novo login. */
  readonly sessionExpiresAt: string;
  /** `true` = mandar para a tela de troca de senha antes de qualquer outra coisa. */
  readonly mustChangePassword: boolean;
}

export interface ChangePasswordRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
}
