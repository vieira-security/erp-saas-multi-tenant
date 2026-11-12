import type { AuditAction, Money, OrderStatus, PaymentMethod } from "@erp/contracts";
import type { AuthContextService } from "../auth/context/auth-context.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { TenantScope } from "../tenancy/tenant-scope.js";
import { hasChanges, type AuditChanges, type AuditFieldChange, type AuditScalar } from "./changes.js";
import type { SecurityAuditEvent } from "./security-audit.js";

/**
 * Eventos de NEGÓCIO do histórico de auditoria (KAN-41) gravados em `audit_logs`. Mesmo princípio do
 * SecurityAuditWriter: cada ação é um tipo fechado com o SEU formato de metadados, montado aqui (nunca um objeto de
 * request/DTO nem `Record<string, any>` solto), e conferido de novo antes de gravar (allowlist de chaves por ação +
 * recusa de qualquer chave com cara de credencial, em qualquer nível).
 *
 * Regras (docs/security.md, "Histórico de auditoria"):
 * - grava NA MESMA TRANSAÇÃO da ação (quem chama passa o client da transação): rollback da ação leva o evento junto, e
 *   falha da auditoria derruba a ação;
 * - `user_id` = ator; `branch_id` = filial do evento ou `null` (evento do tenant); `resource_type`/`resource_id` = o
 *   recurso alterado;
 * - `*.updated` com `changes` vazio (nada mudou) não grava nada: operação idempotente sem mudança não audita.
 */

export interface AuditActor {
  readonly userId: string;
  readonly deviceId: string | null;
}

/**
 * Ator da operação em curso: o usuário autenticado (AuthContext aberto pelo AuthGuard) ou `null` = sistema, quando não
 * há requisição autenticada (seed de desenvolvimento, rotinas). Rotas de negócio sempre passam pelo AuthGuard, então o
 * `null` nunca aparece numa ação feita pela API.
 */
export function auditActorOf(auth: AuthContextService): AuditActor | null {
  const current = auth.current();
  return current ? { userId: current.userId, deviceId: current.deviceId } : null;
}

export interface OptionGroupCount {
  readonly groups: number;
  readonly options: number;
}

export interface AuditRefund {
  readonly method: PaymentMethod;
  readonly amount: Money;
}

export type ProductAuditField = "name" | "description" | "code" | "categoryId" | "kitchenSectorId" | "basePrice" | "sortOrder";
export type CompanyAuditField = "legalName" | "tradeName" | "timezone";
export type BranchAuditField = "name" | "code" | "cnpj" | "timezone";

export type BusinessAuditEvent =
  // Organização (tenant)
  | { action: "organization.updated"; tenantId: string; changes: AuditChanges<"name"> }
  | { action: "company.created"; companyId: string; legalName: string; tradeName: string; cnpj: string; timezone: string }
  | { action: "company.updated"; companyId: string; changes: AuditChanges<CompanyAuditField> }
  | { action: "company.activated" | "company.deactivated"; companyId: string }
  // Filial: o evento é DA filial (branch_id = ela mesma)
  | { action: "branch.created"; branchId: string; companyId: string; name: string; code: string; cnpj: string | null; timezone: string }
  | { action: "branch.updated"; branchId: string; changes: AuditChanges<BranchAuditField> }
  | { action: "branch.activated" | "branch.deactivated"; branchId: string }
  | { action: "branch_access.granted" | "branch_access.revoked"; branchId: string; targetUserId: string }
  // Cardápio do tenant
  | { action: "product_category.created"; categoryId: string; name: string; sortOrder: number }
  | { action: "product_category.updated"; categoryId: string; changes: AuditChanges<"name" | "sortOrder"> }
  | { action: "product_category.activated" | "product_category.deactivated"; categoryId: string }
  | {
      action: "product.created";
      productId: string;
      name: string;
      code: string | null;
      categoryId: string | null;
      kitchenSectorId: string | null;
      basePrice: Money;
      sortOrder: number;
      optionGroups: OptionGroupCount;
    }
  | { action: "product.updated"; productId: string; changes: AuditChanges<ProductAuditField> }
  | { action: "product.option_groups_replaced"; productId: string; before: OptionGroupCount; after: OptionGroupCount }
  | { action: "product.activated" | "product.deactivated"; productId: string }
  // Ajuste do produto na filial (recurso = o produto; o ajuste pode ser apagado ao voltar ao padrão)
  | { action: "branch_product_setting.updated"; branchId: string; productId: string; changes: AuditChanges<"available" | "price"> }
  // Caixa e dinheiro
  | { action: "cash_session.opened"; branchId: string; cashSessionId: string; openingAmount: Money }
  | {
      action: "cash_session.closed";
      branchId: string;
      cashSessionId: string;
      expectedCash: Money;
      countedCash: Money;
      /** Contado − esperado; negativo = falta (`"-5.00"`). */
      difference: string;
      justification: string | null;
    }
  | { action: "cash_movement.withdrawal" | "cash_movement.supply"; branchId: string; cashMovementId: string; cashSessionId: string; amount: Money; reason: string }
  | {
      action: "order.cancelled";
      branchId: string;
      orderId: string;
      /** `null` = rascunho (EDITING), que ainda não tem número. */
      number: number | null;
      previousStatus: OrderStatus;
      reason: string | null;
      refunds: readonly AuditRefund[];
    }
  // Cozinha
  | { action: "kitchen_sector.created"; sectorId: string; name: string; code: string; sortOrder: number }
  | { action: "kitchen_sector.updated"; sectorId: string; changes: AuditChanges<"name" | "code" | "sortOrder"> }
  | { action: "kitchen_sector.activated" | "kitchen_sector.deactivated"; sectorId: string }
  | { action: "kitchen_sector.default_changed"; fromSectorId: string | null; toSectorId: string }
  | { action: "branch_kitchen_sector.updated"; branchId: string; sectorId: string; changes: AuditChanges<"enabled"> }
  /** Só a via ≥ 2 (a primeira impressão não é reimpressão). */
  | { action: "kitchen_ticket.reprinted"; branchId: string; ticketId: string; orderId: string; sectorId: string; copyNumber: number };

export type BusinessAuditAction = BusinessAuditEvent["action"];

// Catálogo do contrato == ações dos dois writers (negócio + segurança). Ação nova sem entrar no catálogo (ou ação do
// catálogo que ninguém grava) falha o typecheck.
type WrittenAction = BusinessAuditAction | SecurityAuditEvent["action"];
const catalogMatchesWriters: [Exclude<AuditAction, WrittenAction>, Exclude<WrittenAction, AuditAction>] extends [never, never] ? true : never = true;
void catalogMatchesWriters;

type JsonValue = AuditScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type Metadata = { readonly [key: string]: JsonValue };

interface BusinessAuditRow {
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly branchId: string | null;
  readonly metadata: Metadata | null;
}

const row = (resourceType: string, resourceId: string, branchId: string | null, metadata: Metadata | null = null): BusinessAuditRow => ({
  resourceType,
  resourceId,
  branchId,
  metadata,
});
const counts = (c: OptionGroupCount): Metadata => ({ groups: c.groups, options: c.options });
/** `changes` como JSON: só os campos presentes, cada um com `{ from, to }`. */
const json = (changes: AuditChanges<string>): Metadata =>
  Object.fromEntries(
    Object.entries(changes)
      .filter((entry): entry is [string, AuditFieldChange] => entry[1] !== undefined)
      .map(([field, change]) => [field, { from: change.from, to: change.to }]),
  );

/** Monta a linha de cada ação. Exaustivo: ação nova sem caso aqui não compila. */
export function toBusinessAuditRow(event: BusinessAuditEvent): BusinessAuditRow {
  switch (event.action) {
    case "organization.updated":
      return row("organization", event.tenantId, null, { changes: json(event.changes) });
    case "company.created":
      return row("company", event.companyId, null, {
        legalName: event.legalName,
        tradeName: event.tradeName,
        cnpj: event.cnpj,
        timezone: event.timezone,
      });
    case "company.updated":
      return row("company", event.companyId, null, { changes: json(event.changes) });
    case "company.activated":
    case "company.deactivated":
      return row("company", event.companyId, null);
    case "branch.created":
      return row("branch", event.branchId, event.branchId, {
        companyId: event.companyId,
        name: event.name,
        code: event.code,
        cnpj: event.cnpj,
        timezone: event.timezone,
      });
    case "branch.updated":
      return row("branch", event.branchId, event.branchId, { changes: json(event.changes) });
    case "branch.activated":
    case "branch.deactivated":
      return row("branch", event.branchId, event.branchId);
    case "branch_access.granted":
    case "branch_access.revoked":
      return row("user", event.targetUserId, event.branchId, { targetUserId: event.targetUserId });
    case "product_category.created":
      return row("product_category", event.categoryId, null, { name: event.name, sortOrder: event.sortOrder });
    case "product_category.updated":
      return row("product_category", event.categoryId, null, { changes: json(event.changes) });
    case "product_category.activated":
    case "product_category.deactivated":
      return row("product_category", event.categoryId, null);
    case "product.created":
      return row("product", event.productId, null, {
        name: event.name,
        code: event.code,
        categoryId: event.categoryId,
        kitchenSectorId: event.kitchenSectorId,
        basePrice: event.basePrice,
        sortOrder: event.sortOrder,
        optionGroups: counts(event.optionGroups),
      });
    case "product.updated":
      return row("product", event.productId, null, { changes: json(event.changes) });
    case "product.option_groups_replaced":
      return row("product", event.productId, null, { before: counts(event.before), after: counts(event.after) });
    case "product.activated":
    case "product.deactivated":
      return row("product", event.productId, null);
    case "branch_product_setting.updated":
      return row("product", event.productId, event.branchId, { changes: json(event.changes) });
    case "cash_session.opened":
      return row("cash_session", event.cashSessionId, event.branchId, { openingAmount: event.openingAmount });
    case "cash_session.closed":
      return row("cash_session", event.cashSessionId, event.branchId, {
        expectedCash: event.expectedCash,
        countedCash: event.countedCash,
        difference: event.difference,
        justification: event.justification,
      });
    case "cash_movement.withdrawal":
    case "cash_movement.supply":
      return row("cash_movement", event.cashMovementId, event.branchId, {
        amount: event.amount,
        reason: event.reason,
        cashSessionId: event.cashSessionId,
      });
    case "order.cancelled":
      return row("order", event.orderId, event.branchId, {
        number: event.number,
        previousStatus: event.previousStatus,
        reason: event.reason,
        refunds: event.refunds.map((r) => ({ method: r.method, amount: r.amount })),
      });
    case "kitchen_sector.created":
      return row("kitchen_sector", event.sectorId, null, { name: event.name, code: event.code, sortOrder: event.sortOrder });
    case "kitchen_sector.updated":
      return row("kitchen_sector", event.sectorId, null, { changes: json(event.changes) });
    case "kitchen_sector.activated":
    case "kitchen_sector.deactivated":
      return row("kitchen_sector", event.sectorId, null);
    case "kitchen_sector.default_changed":
      return row("kitchen_sector", event.toSectorId, null, { fromSectorId: event.fromSectorId, toSectorId: event.toSectorId });
    case "branch_kitchen_sector.updated":
      return row("kitchen_sector", event.sectorId, event.branchId, { changes: json(event.changes) });
    case "kitchen_ticket.reprinted":
      return row("kitchen_ticket", event.ticketId, event.branchId, {
        copyNumber: event.copyNumber,
        orderId: event.orderId,
        sectorId: event.sectorId,
      });
  }
}

/** Chaves de metadados aceitas em cada ação (além da forma tipada acima: defesa em profundidade, fail-closed). */
export const BUSINESS_METADATA_KEYS: Readonly<Record<BusinessAuditAction, readonly string[]>> = {
  "organization.updated": ["changes"],
  "company.created": ["legalName", "tradeName", "cnpj", "timezone"],
  "company.updated": ["changes"],
  "company.activated": [],
  "company.deactivated": [],
  "branch.created": ["companyId", "name", "code", "cnpj", "timezone"],
  "branch.updated": ["changes"],
  "branch.activated": [],
  "branch.deactivated": [],
  "branch_access.granted": ["targetUserId"],
  "branch_access.revoked": ["targetUserId"],
  "product_category.created": ["name", "sortOrder"],
  "product_category.updated": ["changes"],
  "product_category.activated": [],
  "product_category.deactivated": [],
  "product.created": ["name", "code", "categoryId", "kitchenSectorId", "basePrice", "sortOrder", "optionGroups"],
  "product.updated": ["changes"],
  "product.option_groups_replaced": ["before", "after"],
  "product.activated": [],
  "product.deactivated": [],
  "branch_product_setting.updated": ["changes"],
  "cash_session.opened": ["openingAmount"],
  "cash_session.closed": ["expectedCash", "countedCash", "difference", "justification"],
  "cash_movement.withdrawal": ["amount", "reason", "cashSessionId"],
  "cash_movement.supply": ["amount", "reason", "cashSessionId"],
  "order.cancelled": ["number", "previousStatus", "reason", "refunds"],
  "kitchen_sector.created": ["name", "code", "sortOrder"],
  "kitchen_sector.updated": ["changes"],
  "kitchen_sector.activated": [],
  "kitchen_sector.deactivated": [],
  "kitchen_sector.default_changed": ["fromSectorId", "toSectorId"],
  "branch_kitchen_sector.updated": ["changes"],
  "kitchen_ticket.reprinted": ["copyNumber", "orderId", "sectorId"],
};

/** Qualquer chave, em qualquer nível (inclusive o nome de um campo em `changes`), com cara de credencial ou cartão. */
const SECRET_KEY = /(password|passwd|senha|hash|token|secret|credential|api_?key|private_?key|(^|_)pin($|_)|card|cartao|cvv|pan$)/i;
const MAX_STRING = 1000;
const MAX_DEPTH = 4;

export class UnsafeBusinessAuditMetadataError extends Error {
  override readonly name = "UnsafeBusinessAuditMetadataError";
  constructor(action: string, path: string) {
    super(`Audit metadata not allowed for ${action}: ${path}`);
  }
}

function assertSafeValue(action: string, path: string, value: unknown, depth: number): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeBusinessAuditMetadataError(action, path);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING) throw new UnsafeBusinessAuditMetadataError(action, path);
    return;
  }
  if (depth >= MAX_DEPTH) throw new UnsafeBusinessAuditMetadataError(action, path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSafeValue(action, `${path}[${i}]`, item, depth + 1));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new UnsafeBusinessAuditMetadataError(action, `${path}.${key}`);
      assertSafeValue(action, `${path}.${key}`, nested, depth + 1);
    }
    return;
  }
  throw new UnsafeBusinessAuditMetadataError(action, path);
}

/** Defesa em profundidade: só as chaves da ação, valores JSON simples, nenhuma chave com cara de segredo. */
export function assertSafeBusinessMetadata(action: BusinessAuditAction, metadata: Metadata | null): void {
  if (metadata === null) {
    if (BUSINESS_METADATA_KEYS[action].length > 0) throw new UnsafeBusinessAuditMetadataError(action, "<root>");
    return;
  }
  const allowed = new Set(BUSINESS_METADATA_KEYS[action]);
  for (const key of Object.keys(metadata)) {
    if (!allowed.has(key) || SECRET_KEY.test(key)) throw new UnsafeBusinessAuditMetadataError(action, key);
  }
  assertSafeValue(action, "", metadata, 0);
}

function isEmptyUpdate(event: BusinessAuditEvent): boolean {
  return "changes" in event && !hasChanges(event.changes);
}

type AuditDb = Pick<PrismaClient, "auditLog"> | Pick<Prisma.TransactionClient, "auditLog">;

/**
 * Grava eventos de negócio no tenant atual (TenantScope). `db` DEVE ser o client da transação da ação: é isso que faz o
 * evento sumir no rollback e a ação falhar se a auditoria falhar.
 */
export class BusinessAuditWriter {
  constructor(
    private readonly db: AuditDb,
    private readonly scope: TenantScope,
  ) {}

  /** `false` quando não gravou (alteração sem nenhuma mudança). */
  async record(actor: AuditActor | null, event: BusinessAuditEvent): Promise<boolean> {
    if (isEmptyUpdate(event)) return false;
    const r = toBusinessAuditRow(event);
    assertSafeBusinessMetadata(event.action, r.metadata);
    await this.db.auditLog.create({
      data: this.scope.data({
        action: event.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        branchId: r.branchId,
        userId: actor?.userId ?? null,
        deviceId: actor?.deviceId ?? null,
        ...(r.metadata ? { metadata: r.metadata as Prisma.InputJsonObject } : {}),
      }),
    });
    return true;
  }
}
