import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "../database/database.module.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { normalizeLoginCode } from "../tenants/login-code.js";
import type { LoginTenantResolver, ResolvedLoginTenant } from "./login-tenant.js";
import { AuthTenantRepository } from "./persistence/auth-lookup.repository.js";

/**
 * Resolver aprovado (decisão de produto do M2): o código PÚBLICO de login da organização (`tenants.login_code`) diz em
 * qual tenant a matrícula é procurada. O código não é segredo e não autentica nada: depois dele, matrícula + senha
 * continuam obrigatórias e todas as regras do login se aplicam. Código inválido/inexistente = `null`.
 */
@Injectable()
export class LoginCodeTenantResolver implements LoginTenantResolver<unknown> {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async resolve(rawLoginCode: unknown): Promise<ResolvedLoginTenant | null> {
    const loginCode = normalizeLoginCode(rawLoginCode);
    if (!loginCode) return null;
    const tenantId = await new AuthTenantRepository(this.prisma).findIdByLoginCode(loginCode);
    return tenantId ? { tenantId } : null;
  }
}
