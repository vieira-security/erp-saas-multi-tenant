import { Inject, Injectable } from "@nestjs/common";
import type { Page, RoleStatus, UserDto, UserRoleAssignmentDto, UserStatus, UserSummaryDto } from "@erp/contracts";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { Prisma, RoleStatus as DbRoleStatus, type PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { toPage, type PageRequest } from "../http/paging.js";
import { BRANCH_SUMMARY_SELECT, toBranchSummaryDto } from "../organization/dto.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { normalizeEmployeeNumber } from "./employee-number.js";
import { likeContainsPattern, type UserListFilter } from "./list-users-query.js";

interface UserSummaryRow {
  id: string;
  name: string;
  employeeNumber: string;
  status: UserStatus;
  createdAt: Date;
}

/**
 * Colunas que a leitura de usuários pode devolver: nunca `password_hash`, `failed_login_attempts`, `locked_until`,
 * `last_login_at`, `disabled_at` nem sessões (docs/security.md). Sempre `select` explícito, nunca o model inteiro.
 */
const USER_DETAIL_SELECT = {
  id: true,
  name: true,
  employeeNumber: true,
  status: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
  roles: {
    select: {
      roleId: true,
      branchId: true,
      role: { select: { code: true, name: true, status: true } },
      // Role escopada: a filial vem pelo UserBranchAccess da FK composta (mesmo tenant e mesmo usuário).
      branchAccess: { select: { branch: { select: BRANCH_SUMMARY_SELECT } } },
    },
  },
} as const satisfies Prisma.UserSelect;

/** Comparação por código (UTF-16), independente de locale/collation. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `ARCHIVED` existe no banco mas não no contrato (`ROLE_STATUSES` = ACTIVE | INACTIVE). Role arquivada também não concede
 * permissão; sai como `INACTIVE` para a tela mostrar a atribuição sem afirmar que ela vale (DECISION REQUIRED no PR).
 */
function toRoleStatus(status: DbRoleStatus): RoleStatus {
  return status === DbRoleStatus.ACTIVE ? "ACTIVE" : "INACTIVE";
}

function toUserSummaryDto(row: UserSummaryRow): UserSummaryDto {
  return { id: row.id, name: row.name, employeeNumber: row.employeeNumber, status: row.status, createdAt: row.createdAt.toISOString() };
}

/**
 * Funcionários do tenant atual — SOMENTE LEITURA (KAN-29). Tenant só do TenantContext (TenantScope / `scope.tenantId()`),
 * usuário de outro tenant = 404. Sem auditoria (leitura, como as demais listagens).
 */
@Injectable()
export class UserService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
  ) {}

  /**
   * Página + contagem numa transação (2 queries, mesmo filtro). SQL parametrizado porque o Prisma não expõe `COLLATE`
   * no `orderBy`: a ordem é `name COLLATE "C"` (byte a byte em UTF-8 = ordem de code point) e, em empate, `id`, igual em
   * qualquer banco, sem depender da collation padrão. `tenant_id` é explícito e vem do TenantContext.
   *
   * `search`: nome contém (`ILIKE`, curingas do termo escapados) OU matrícula igual. A matrícula é comparada já
   * normalizada (`normalizeEmployeeNumber`, mesma regra do login: `e001` = `E001`); termo que não é matrícula válida só
   * busca por nome. Matrícula parcial não casa.
   */
  async list(filter: UserListFilter, page: PageRequest): Promise<Page<UserSummaryDto>> {
    const conditions: Prisma.Sql[] = [Prisma.sql`tenant_id = ${this.scope.tenantId()}::uuid`];
    if (filter.status) conditions.push(Prisma.sql`status = ${filter.status}::user_status`);
    if (filter.search !== undefined) {
      const byName = Prisma.sql`name ILIKE ${likeContainsPattern(filter.search)} ESCAPE '\\'`;
      const employeeNumber = normalizeEmployeeNumber(filter.search);
      conditions.push(employeeNumber ? Prisma.sql`(${byName} OR employee_number = ${employeeNumber})` : byName);
    }
    const where = Prisma.join(conditions, " AND ");
    const [rows, counted] = await this.prisma.$transaction([
      this.prisma.$queryRaw<UserSummaryRow[]>`
        SELECT id, name, employee_number AS "employeeNumber", status::text AS status, created_at AS "createdAt"
        FROM users WHERE ${where}
        ORDER BY name COLLATE "C", id
        LIMIT ${page.take} OFFSET ${page.skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM users WHERE ${where}`,
    ]);
    return toPage(rows, counted[0]?.total ?? 0, page, toUserSummaryDto);
  }

  /** Uma leitura com as roles e filiais aninhadas (sem laço de queries). Roles: tenant inteiro, filial (`code`), `code`. */
  async get(id: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: this.scope.where({ id }), select: USER_DETAIL_SELECT });
    if (!user) throw new NotFoundError("User");
    const roles: UserRoleAssignmentDto[] = user.roles.map((assignment) => ({
      roleId: assignment.roleId,
      code: assignment.role.code,
      name: assignment.role.name,
      status: toRoleStatus(assignment.role.status),
      branch: assignment.branchAccess ? toBranchSummaryDto(assignment.branchAccess.branch) : null,
    }));
    roles.sort(
      (a, b) =>
        Number(a.branch !== null) - Number(b.branch !== null) ||
        byCode(a.branch?.code ?? "", b.branch?.code ?? "") ||
        byCode(a.code, b.code) ||
        byCode(a.branch?.id ?? "", b.branch?.id ?? "") ||
        byCode(a.roleId, b.roleId),
    );
    return {
      ...toUserSummaryDto(user),
      mustChangePassword: user.mustChangePassword,
      updatedAt: user.updatedAt.toISOString(),
      roles,
    };
  }
}
