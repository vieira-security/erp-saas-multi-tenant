import type { Money } from "@erp/contracts";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { toMoney } from "../http/money.js";
import type { TenantScope } from "../tenancy/tenant-scope.js";
import { summarizeSession, type SessionSummary } from "./cash-math.js";

/**
 * Lê o razão de UM caixa (abertura, pagamentos, estornos lançados nele e movimentos) e calcula o resumo em centavos
 * (cash-math.ts). Compartilhado pelo módulo `cash` (detalhe, sangria, fechamento) e pelo `orders` (estorno em dinheiro no
 * cancelamento): quem chama deve ter o caixa travado (`FOR UPDATE`, cash-lock.ts) para o valor não mudar até o commit.
 * Toda leitura leva TenantScope e a filial.
 */
export async function loadSessionSummary(
  db: Prisma.TransactionClient | PrismaClient,
  scope: TenantScope,
  branchId: string,
  sessionId: string,
): Promise<SessionSummary & { openingAmount: Money }> {
  const where = scope.where({ branchId, cashSessionId: sessionId });
  const session = await db.cashSession.findFirstOrThrow({ where: scope.where({ id: sessionId, branchId }), select: { openingAmount: true } });
  const payments = await db.payment.findMany({ where, select: { method: true, amount: true } });
  const refunds = await db.refund.findMany({ where, select: { method: true, amount: true } });
  const movements = await db.cashMovement.findMany({ where, select: { type: true, amount: true } });
  const openingAmount = toMoney(session.openingAmount);
  const summary = summarizeSession({
    openingAmount,
    payments: payments.map((p) => ({ method: p.method, amount: toMoney(p.amount) })),
    refunds: refunds.map((r) => ({ method: r.method, amount: toMoney(r.amount) })),
    movements: movements.map((m) => ({ type: m.type, amount: toMoney(m.amount) })),
  });
  return { ...summary, openingAmount };
}
