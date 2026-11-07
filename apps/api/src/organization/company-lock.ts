import type { CompanyStatus, Prisma } from "../generated/prisma/client.js";

/**
 * Trava a linha da Company do tenant atual dentro de uma transação e devolve o estado MAIS RECENTE dela (`null` se não
 * existir no tenant). SQL bruto porque o Prisma não expõe `FOR SHARE/UPDATE`; o filtro de `tenant_id` é explícito e vem
 * do TenantContext (quem chama passa `scope.tenantId()`). Exige `UPDATE` em `companies`, que `erp_app` já tem.
 *
 * Invariante protegida: filial ACTIVE só sob Company ACTIVE.
 * - criar/ativar filial: `share` (várias filiais em paralelo, mas bloqueia desativar a empresa até o commit);
 * - desativar empresa: `update` (espera as transações de filial e só então conta as filiais ativas, já commitadas).
 */
export async function lockCompany(
  tx: Prisma.TransactionClient,
  tenantId: string,
  companyId: string,
  mode: "share" | "update",
): Promise<{ status: CompanyStatus; cnpj: string; timezone: string } | null> {
  const rows =
    mode === "share"
      ? await tx.$queryRaw<{ status: CompanyStatus; cnpj: string; timezone: string }[]>`
          SELECT status, cnpj, timezone FROM companies
          WHERE tenant_id = ${tenantId}::uuid AND id = ${companyId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ status: CompanyStatus; cnpj: string; timezone: string }[]>`
          SELECT status, cnpj, timezone FROM companies
          WHERE tenant_id = ${tenantId}::uuid AND id = ${companyId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}
