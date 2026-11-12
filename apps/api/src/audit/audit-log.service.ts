import { Inject, Injectable } from "@nestjs/common";
import type { AuditAction, AuditLogDto, Page } from "@erp/contracts";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PermissionDeniedError, UnauthenticatedError } from "../auth/errors.js";
import type { RoleAssignment } from "../authorization/effective-permissions.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { Prisma, RoleStatus, UserStatus, type PrismaClient } from "../generated/prisma/client.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { AUDIT_ACTION_CATALOG } from "./audit-catalog.js";
import { auditVisibility, seesNothing, type AuditVisibility } from "./audit-visibility.js";
import type { AuditLogFilter } from "./list-audit-logs-query.js";

interface AuditLogRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  userId: string | null;
  userName: string | null;
  branchId: string | null;
  branchName: string | null;
  branchCode: string | null;
}

/**
 * GET /audit-logs (KAN-41). A rota exige só autenticação; ESTE service decide a visibilidade com as permissões efetivas
 * do ator (exceção documentada ao padrão declarativo, como o cancelamento de pedido: a regra depende de filial por
 * filial, não de um escopo único). Regras (audit-visibility.ts):
 * - nada visível = 403; filtro `branchId` sem `audit.read` naquela filial = 403;
 * - visibilidade aplicada NO SQL (tenant do contexto + filiais visíveis + eventos sem filial só com `audit.read_tenant`),
 *   então página e `total` seguem a mesma regra;
 * - só ações do catálogo do contrato (`AUDIT_ACTIONS`, espelhado em audit-catalog.ts): uma ação gravada fora dele (não deveria existir — o typecheck
 *   amarra os writers ao catálogo) não aparece, em vez de quebrar o tipo `AuditAction` do cliente;
 * - `actor` (nome ATUAL) e `branch` (nome e código atuais) vêm de LEFT JOIN na mesma leitura (sem N+1); `metadata` como
 *   gravado. Página e contagem numa transação REPEATABLE READ (mesmo snapshot).
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  async list(filter: AuditLogFilter, page: PageRequest): Promise<Page<AuditLogDto>> {
    const { userId } = this.auth.require();
    const visibility = await this.visibility(userId);
    if (seesNothing(visibility)) throw new PermissionDeniedError();
    if (filter.branchId !== undefined && !visibility.branchIds.includes(filter.branchId)) throw new PermissionDeniedError();

    const where = this.whereClause(filter, visibility);
    const [rows, counted] = await this.prisma.$transaction(
      async (tx) =>
        Promise.all([
          tx.$queryRaw<AuditLogRow[]>`
            SELECT a.id::text AS id, a.action, a.resource_type AS "resourceType", a.resource_id::text AS "resourceId",
                   a.metadata, a.created_at AS "createdAt",
                   a.user_id::text AS "userId", u.name AS "userName",
                   a.branch_id::text AS "branchId", b.name AS "branchName", b.code AS "branchCode"
            FROM audit_logs a
            LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
            LEFT JOIN branches b ON b.tenant_id = a.tenant_id AND b.id = a.branch_id
            WHERE ${where}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ${page.take} OFFSET ${page.skip}`,
          tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM audit_logs a WHERE ${where}`,
        ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return toPage(rows, counted[0]?.total ?? 0, page, toAuditLogDto);
  }

  /** Condições do WHERE, todas parametrizadas. `tenant_id` do contexto SEMPRE; filiais visíveis SEMPRE. */
  private whereClause(filter: AuditLogFilter, visibility: AuditVisibility): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`a.tenant_id = ${this.scope.tenantId()}::uuid`,
      Prisma.sql`a.action = ANY(${[...AUDIT_ACTION_CATALOG]}::text[])`,
    ];
    if (filter.branchId !== undefined) {
      // Já conferido acima: a filial está entre as visíveis.
      conditions.push(Prisma.sql`a.branch_id = ${filter.branchId}::uuid`);
    } else {
      const branches = Prisma.sql`a.branch_id = ANY(${[...visibility.branchIds]}::uuid[])`;
      conditions.push(visibility.tenantEvents ? Prisma.sql`(${branches} OR a.branch_id IS NULL)` : branches);
    }
    if (filter.from) conditions.push(Prisma.sql`a.created_at >= ${filter.from}`);
    if (filter.to) conditions.push(Prisma.sql`a.created_at < ${filter.to}`);
    if (filter.actions) conditions.push(Prisma.sql`a.action = ANY(${[...filter.actions]}::text[])`);
    if (filter.userId) conditions.push(Prisma.sql`a.user_id = ${filter.userId}::uuid`);
    if (filter.resourceType) conditions.push(Prisma.sql`a.resource_type = ${filter.resourceType}`);
    if (filter.resourceId) conditions.push(Prisma.sql`a.resource_id = ${filter.resourceId}::uuid`);
    return Prisma.join(conditions, " AND ");
  }

  /** Mesmas leituras (e regra) do GET /me: usuário ACTIVE, acessos às filiais, roles ACTIVE com as permissões. */
  private async visibility(userId: string): Promise<AuditVisibility> {
    const [user, accesses, assignments] = await this.prisma.$transaction([
      this.prisma.user.findUnique({ where: this.scope.where({ id: userId }), select: { status: true } }),
      this.prisma.userBranchAccess.findMany({ where: this.scope.where({ userId }), select: { branchId: true } }),
      this.prisma.userRole.findMany({
        where: this.scope.where({ userId, role: { status: RoleStatus.ACTIVE } }),
        select: { branchId: true, role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } },
      }),
    ]);
    if (!user) throw new UnauthenticatedError("user_not_found");
    const roles: RoleAssignment[] =
      user.status === UserStatus.ACTIVE ? assignments.map((a) => ({ branchId: a.branchId, permissions: a.role.permissions.map((rp) => rp.permission.code) })) : [];
    return auditVisibility(roles, new Set(accesses.map((a) => a.branchId)));
  }
}

function toAuditLogDto(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    action: row.action as AuditAction,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    branch: row.branchId !== null ? { id: row.branchId, name: row.branchName ?? "", code: row.branchCode ?? "" } : null,
    actor: row.userId !== null ? { userId: row.userId, name: row.userName ?? "" } : null,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}
