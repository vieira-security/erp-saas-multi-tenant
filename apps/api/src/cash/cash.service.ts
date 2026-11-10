import { Inject, Injectable } from "@nestjs/common";
import type { CashMovementType, CashSessionDto, CashSessionStatus, CashSessionSummaryDto, Money, Page } from "@erp/contracts";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PermissionDeniedError } from "../auth/errors.js";
import { AuthorizationService, branchScope } from "../authorization/authorization.service.js";
import { CLOCK, type Clock } from "../clock/clock.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { CashSessionStatus as DbStatus, type Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../http/api-error.js";
import { moneyToCents, toMoney } from "../http/money.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { lockBranchAndCompany } from "../orders/order-lock.js";
import { isUniqueViolation } from "../organization/prisma-errors.js";
import { loadSessionSummary } from "./cash-ledger.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { lockSession } from "./cash-lock.js";
import { closingDifference, type SessionSummary } from "./cash-math.js";

type Tx = Prisma.TransactionClient;

const ACTOR = { select: { id: true, name: true } } as const;
const actor = (u: { id: string; name: string }) => ({ userId: u.id, name: u.name });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Caixas da filial (M6). Toda query leva TenantScope + filial da rota (caixa de outra filial/tenant = 404). O acesso à
 * filial já foi exigido pelo PermissionGuard. Regras que dependem de QUEM é o dono do caixa (ver docs/security.md):
 * - listar/ver: sem `cash.close` na filial, só os próprios caixas (o de outro operador é 404 — não revela existência);
 * - fechar: o próprio com `cash.open`; o de outro operador só com `cash.close` (senão 403);
 * - sangria/suprimento: `cash.close` (declarado na rota).
 * Dinheiro sempre em centavos `bigint` (cash-math.ts). Operações que mexem no dinheiro travam o caixa (cash-lock.ts).
 */
@Injectable()
export class CashService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Abre o caixa do usuário (fundo ≥ 0). Um OPEN por operador e filial (índice único parcial -> 409). */
  async open(branchId: string, openingAmount: Money): Promise<CashSessionDto> {
    const { userId } = this.auth.require();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const branch = await lockBranchAndCompany(tx, this.scope.tenantId(), branchId);
        if (!branch) throw new NotFoundError("Branch");
        if (branch.branchStatus !== "ACTIVE") throw new ConflictError("branch_inactive");
        if (branch.companyStatus !== "ACTIVE") throw new ConflictError("company_inactive");
        const session = await tx.cashSession.create({
          data: this.scope.data({ branchId, status: DbStatus.OPEN, openedBy: userId, openedAt: this.clock.now(), openingAmount }),
        });
        return this.detail(tx, branchId, session.id);
      });
    } catch (error) {
      // A única unique que um INSERT novo pode violar é o índice parcial de caixa OPEN por operador.
      if (isUniqueViolation(error)) throw new ConflictError("cash_session_already_open");
      throw error;
    }
  }

  async current(branchId: string): Promise<CashSessionDto> {
    const { userId } = this.auth.require();
    const session = await this.prisma.cashSession.findFirst({ where: this.scope.where({ branchId, openedBy: userId, status: DbStatus.OPEN }), select: { id: true } });
    if (!session) throw new NotFoundError("Cash session");
    return this.detail(this.prisma, branchId, session.id);
  }

  /** Mais recentes primeiro. Sem `cash.close` na filial: só os caixas do próprio usuário. */
  async list(branchId: string, filter: { status?: CashSessionStatus }, page: PageRequest): Promise<Page<CashSessionSummaryDto>> {
    const { userId } = this.auth.require();
    const seesAll = await this.can(userId, branchId, "cash.close");
    const where = this.scope.where({ branchId, ...(seesAll ? {} : { openedBy: userId }), ...(filter.status ? { status: filter.status } : {}) });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cashSession.findMany({ where, include: { opener: ACTOR }, orderBy: [{ openedAt: "desc" }, { id: "desc" }], skip: page.skip, take: page.take }),
      this.prisma.cashSession.count({ where }),
    ]);
    return toPage(rows, total, page, (s) => ({
      id: s.id,
      branchId: s.branchId,
      status: s.status,
      openedBy: actor(s.opener),
      openedAt: s.openedAt.toISOString(),
      openingAmount: toMoney(s.openingAmount),
      closedAt: iso(s.closedAt),
      difference: s.difference === null ? null : toMoney(s.difference),
    }));
  }

  /** Caixa de outro operador sem `cash.close` = 404 (não revela que existe). */
  async get(branchId: string, sessionId: string): Promise<CashSessionDto> {
    const { userId } = this.auth.require();
    const session = await this.prisma.cashSession.findFirst({ where: this.scope.where({ id: sessionId, branchId }), select: { openedBy: true } });
    if (!session || (session.openedBy !== userId && !(await this.can(userId, branchId, "cash.close")))) throw new NotFoundError("Cash session");
    return this.detail(this.prisma, branchId, sessionId);
  }

  /** Sangria/suprimento (`cash.close` na rota). Sangria acima do dinheiro esperado = 409 `insufficient_cash`. */
  async addMovement(branchId: string, sessionId: string, input: { type: CashMovementType; amount: Money; reason: string }): Promise<CashSessionDto> {
    const { userId } = this.auth.require();
    return this.prisma.$transaction(async (tx) => {
      const session = await lockSession(tx, this.scope.tenantId(), branchId, sessionId);
      if (!session) throw new NotFoundError("Cash session");
      if (session.status !== DbStatus.OPEN) throw new ConflictError("cash_session_closed");
      if (input.type === "WITHDRAWAL") {
        const { expectedCashCents } = await this.summarize(tx, branchId, sessionId);
        if (moneyToCents(input.amount) > expectedCashCents) throw new ConflictError("insufficient_cash");
      }
      await tx.cashMovement.create({
        data: this.scope.data({ branchId, cashSessionId: sessionId, type: input.type, amount: input.amount, reason: input.reason, createdBy: userId }),
      });
      return this.detail(tx, branchId, sessionId);
    });
  }

  /**
   * Fecha o caixa gravando esperado, contado e diferença (contado − esperado). Próprio caixa: `cash.open`; de outro
   * operador: `cash.close` (403). Já fechado: 409. Diferença ≠ 0 sem justificativa: 400 `justification`/`required`.
   */
  async close(branchId: string, sessionId: string, input: { countedCash: Money; justification: string | null }): Promise<CashSessionDto> {
    const { userId } = this.auth.require();
    return this.prisma.$transaction(async (tx) => {
      const session = await lockSession(tx, this.scope.tenantId(), branchId, sessionId);
      if (!session) throw new NotFoundError("Cash session");
      const needed = session.openedBy === userId ? "cash.open" : "cash.close";
      if (!(await this.can(userId, branchId, needed))) throw new PermissionDeniedError();
      if (session.status !== DbStatus.OPEN) throw new ConflictError("cash_session_closed");
      const { expectedCash, expectedCashCents } = await this.summarize(tx, branchId, sessionId);
      const difference = closingDifference(input.countedCash, expectedCashCents);
      if (difference.cents !== 0n && input.justification === null) throw new ValidationFailedError([{ field: "justification", issue: "required" }]);
      await tx.cashSession.update({
        where: this.scope.where({ id: sessionId }),
        data: {
          status: DbStatus.CLOSED,
          closedBy: userId,
          closedAt: this.clock.now(),
          expectedCash,
          countedCash: input.countedCash,
          difference: difference.money,
          justification: input.justification,
        },
      });
      return this.detail(tx, branchId, sessionId);
    });
  }

  private async can(userId: string, branchId: string, permission: string): Promise<boolean> {
    return (await this.authorization.getEffectivePermissions(userId, branchScope(branchId))).has(permission);
  }

  /** Razão e conta do caixa (cash-ledger.ts, compartilhado com o estorno do módulo `orders`). */
  private summarize(db: Tx | PrismaClient, branchId: string, sessionId: string): Promise<SessionSummary & { openingAmount: Money }> {
    return loadSessionSummary(db, this.scope, branchId, sessionId);
  }

  private async detail(db: Tx | PrismaClient, branchId: string, sessionId: string): Promise<CashSessionDto> {
    const session = await db.cashSession.findFirst({
      where: this.scope.where({ id: sessionId, branchId }),
      include: { opener: ACTOR, closer: ACTOR, movements: { include: { creator: ACTOR } } },
    });
    if (!session) throw new NotFoundError("Cash session");
    const summary = await this.summarize(db, branchId, sessionId);
    return {
      id: session.id,
      branchId: session.branchId,
      status: session.status,
      openedBy: actor(session.opener),
      openedAt: session.openedAt.toISOString(),
      openingAmount: toMoney(session.openingAmount),
      closedAt: iso(session.closedAt),
      difference: session.difference === null ? null : toMoney(session.difference),
      // Fechado: o esperado GRAVADO no fechamento (é o que foi conferido); aberto: o esperado de agora.
      expectedCash: session.expectedCash === null ? summary.expectedCash : toMoney(session.expectedCash),
      totals: summary.totals,
      movements: [...session.movements]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((m) => ({ id: m.id, type: m.type, amount: toMoney(m.amount), reason: m.reason, createdBy: actor(m.creator), createdAt: m.createdAt.toISOString() })),
      closedBy: session.closer ? actor(session.closer) : null,
      countedCash: session.countedCash === null ? null : toMoney(session.countedCash),
      justification: session.justification,
    };
  }
}
