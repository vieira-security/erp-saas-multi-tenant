import type { OrderStatus } from "@erp/contracts";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * Travas de linha do M5 (SQL bruto porque o Prisma não expõe FOR UPDATE/SHARE). Todo comando filtra `tenant_id`
 * explícito, vindo do TenantContext (quem chama passa `scope.tenantId()`), e a filial da rota.
 */

/**
 * Trava o pedido (`FOR UPDATE`) da filial no tenant atual e devolve o estado MAIS RECENTE (`null` = não existe nessa
 * filial/tenant -> 404). Serializa confirmar/cancelar/transições/substituir itens do mesmo pedido: a segunda operação
 * espera e relê o estado já commitado.
 */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  orderId: string,
): Promise<{ status: OrderStatus; createdBy: string } | null> {
  const rows = await tx.$queryRaw<{ status: OrderStatus; createdBy: string }[]>`
    SELECT status::text AS status, created_by::text AS "createdBy" FROM orders
    WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${orderId}::uuid
    FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Lê filial e empresa com trava COMPARTILHADA até o commit (mesmo padrão de company-lock.ts): vários pedidos abrem e
 * confirmam em paralelo, mas desativar a filial (UPDATE da linha) ou a empresa (FOR UPDATE em company-lock.ts) espera o
 * fim desta transação — e, se a desativação chegou antes, esta leitura espera o commit dela e vê INACTIVE. Assim nunca
 * fica pedido aberto/confirmado depois da desativação. Exige UPDATE em branches/companies, que `erp_app` tem.
 */
export async function lockBranchAndCompany(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<{ branchStatus: string; companyStatus: string; timezone: string } | null> {
  const rows = await tx.$queryRaw<{ branchStatus: string; companyStatus: string; timezone: string }[]>`
    SELECT b.status::text AS "branchStatus", c.status::text AS "companyStatus", b.timezone
    FROM branches b JOIN companies c ON c.tenant_id = b.tenant_id AND c.id = b.company_id
    WHERE b.tenant_id = ${tenantId}::uuid AND b.id = ${branchId}::uuid
    FOR SHARE OF b, c`;
  return rows[0] ?? null;
}

/**
 * Próximo número do dia na filial: um único comando atômico. A linha do contador fica travada até o commit da
 * confirmação, então confirmações paralelas recebem números consecutivos, sem repetição; se a transação falhar, o
 * incremento é desfeito (sem lacuna por erro).
 */
export async function nextOrderNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  businessDate: string,
  id: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ number: number }[]>`
    INSERT INTO branch_order_counters (id, tenant_id, branch_id, business_date, last_number, created_at, updated_at)
    VALUES (${id}::uuid, ${tenantId}::uuid, ${branchId}::uuid, ${businessDate}::date, 1, now(), now())
    ON CONFLICT (tenant_id, branch_id, business_date)
    DO UPDATE SET last_number = branch_order_counters.last_number + 1, updated_at = now()
    RETURNING last_number AS number`;
  const number = rows[0]?.number;
  if (number === undefined) throw new Error("order counter returned no row");
  return number;
}
