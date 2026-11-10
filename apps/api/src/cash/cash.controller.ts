import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { CashSessionDto, CashSessionSummaryDto, Page } from "@erp/contracts";
import { RequireBranchPermissions } from "../authorization/permission.guard.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID, oneOf, optional, parseInput, required } from "../http/input.js";
import { money } from "../http/money.js";
import { pageQuerySpec, pageRequest } from "../http/paging.js";
import { CashService } from "./cash.service.js";
import { CASH_SESSION_STATUSES, justification, movementReason, movementType, positiveMoney } from "./validation.js";

function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

/**
 * HTTP do M6 (contrato em `@erp/contracts`, cash.ts). Rotas de FILIAL: o guard exige a permissão NA filial `:branchId`
 * (UserBranchAccess); sem acesso, filial de outro tenant ou inexistente = 403. Exceção documentada: `close` declara só
 * `cash.read` na rota e o service decide (próprio caixa: `cash.open`; de outro operador: `cash.close`).
 */
@Controller("branches/:branchId/cash-sessions")
export class CashController {
  constructor(@Inject(CashService) private readonly cash: CashService) {}

  @Post()
  @RequireBranchPermissions("branchId", "cash.open")
  open(@Param("branchId") branchId: string, @Body() body: unknown): Promise<CashSessionDto> {
    const input = parseInput(body, { openingAmount: required(money) });
    return this.cash.open(routeId(branchId, "Branch"), input.openingAmount);
  }

  /** Rota literal declarada antes de `:sessionId`. */
  @Get("current")
  @RequireBranchPermissions("branchId", "cash.open")
  current(@Param("branchId") branchId: string): Promise<CashSessionDto> {
    return this.cash.current(routeId(branchId, "Branch"));
  }

  @Get()
  @RequireBranchPermissions("branchId", "cash.read")
  list(@Param("branchId") branchId: string, @Query() query: unknown): Promise<Page<CashSessionSummaryDto>> {
    const { status, ...paging } = parseInput(query, { ...pageQuerySpec, status: optional(oneOf(CASH_SESSION_STATUSES)) }, "query");
    return this.cash.list(routeId(branchId, "Branch"), status ? { status } : {}, pageRequest(paging));
  }

  @Get(":sessionId")
  @RequireBranchPermissions("branchId", "cash.read")
  get(@Param("branchId") branchId: string, @Param("sessionId") sessionId: string): Promise<CashSessionDto> {
    return this.cash.get(routeId(branchId, "Branch"), routeId(sessionId, "Cash session"));
  }

  @Post(":sessionId/movements")
  @RequireBranchPermissions("branchId", "cash.close")
  addMovement(@Param("branchId") branchId: string, @Param("sessionId") sessionId: string, @Body() body: unknown): Promise<CashSessionDto> {
    const branch = routeId(branchId, "Branch");
    const session = routeId(sessionId, "Cash session");
    const input = parseInput(body, { type: required(movementType), amount: required(positiveMoney), reason: required(movementReason) });
    return this.cash.addMovement(branch, session, input);
  }

  @Post(":sessionId/close")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "cash.read")
  close(@Param("branchId") branchId: string, @Param("sessionId") sessionId: string, @Body() body: unknown): Promise<CashSessionDto> {
    const branch = routeId(branchId, "Branch");
    const session = routeId(sessionId, "Cash session");
    const input = parseInput(body, { countedCash: required(money), justification: optional(justification) });
    return this.cash.close(branch, session, { countedCash: input.countedCash, justification: input.justification ?? null });
  }
}
