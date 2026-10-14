/**
 * Tenant em que um login acontece, JÁ resolvido por uma fonte confiável antes da autenticação.
 *
 * Decisão do M2: o tenant é resolvido pelo código PÚBLICO de login da organização (`tenants.login_code`, implementação
 * `LoginCodeTenantResolver`). Nunca por `X-Tenant-Id`, slug, subdomínio ou `tenantId` livre em controller. O core
 * (`AuthService.login`) continua recebendo o tenant já resolvido, para que outro resolver confiável (ex.: dispositivo
 * pareado, futuro) possa ser acrescentado sem mudar as regras do login.
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
