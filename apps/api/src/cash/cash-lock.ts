import type { CashSessionStatus } from "@erp/contracts";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * Travas de caixa (SQL bruto: o Prisma não expõe FOR UPDATE). Sempre com `tenant_id` explícito do TenantContext e a
 * filial da rota. Toda operação que muda o dinheiro de um caixa (pagamento na confirmação, estorno em dinheiro, sangria,
 * suprimento, fechamento) trava a linha do caixa `FOR UPDATE` antes de ler/gravar: elas se serializam por caixa, então o
 * esperado calculado no fechamento ou na sangria já inclui tudo o que foi commitado antes, e nada entra depois do
 * fechamento (o trigger check_financial_record_insert também recusa insert em caixa CLOSED).
 */

/**
 * Caixa ABERTO do usuário na filial, travado. Se um fechamento estiver em andamento, espera o commit e reavalia o filtro
 * (READ COMMITTED): caixa que acabou de fechar não é devolvido (`null` -> 409 `cash_session_required`).
 */
export async function lockOpenSessionOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM cash_sessions
    WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND opened_by = ${userId}::uuid AND status = 'OPEN'
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** Um caixa da filial, travado, com o estado MAIS RECENTE (`null` = não existe nessa filial/tenant -> 404). */
export async function lockSession(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  sessionId: string,
): Promise<{ status: CashSessionStatus; openedBy: string } | null> {
  const rows = await tx.$queryRaw<{ status: CashSessionStatus; openedBy: string }[]>`
    SELECT status::text AS status, opened_by::text AS "openedBy" FROM cash_sessions
    WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${sessionId}::uuid
    FOR UPDATE`;
  return rows[0] ?? null;
}
