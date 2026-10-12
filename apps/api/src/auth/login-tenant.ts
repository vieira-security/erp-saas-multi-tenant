/**
 * Tenant em que um login acontece, JÁ resolvido por uma fonte confiável antes da autenticação.
 *
 * DECISION REQUIRED — descoberta pública do tenant pré-login: como o PDV/web informa em qual tenant a matrícula deve ser
 * procurada (dispositivo pareado, subdomínio, código de loja...) não está decidido. Por isso NÃO existe endpoint HTTP de
 * login, nem `X-Tenant-Id`, slug, subdomínio ou `tenantId` livre em controller. O core (`AuthService.login`) recebe este
 * valor de uma implementação de `LoginTenantResolver`, que só existirá quando a regra for aprovada.
 */
export interface ResolvedLoginTenant {
  readonly tenantId: string;
}

/**
 * Contrato do resolver confiável. Uma implementação deve derivar o tenant de algo que o cliente não escolhe livremente
 * (ex.: credencial de dispositivo pareado). Nunca de header/body/query sem verificação.
 */
export interface LoginTenantResolver<Input> {
  resolve(input: Input): Promise<ResolvedLoginTenant | null>;
}
