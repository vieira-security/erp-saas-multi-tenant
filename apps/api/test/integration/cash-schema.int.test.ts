import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CashSessionStatus,
  CompanyStatus,
  OrderStatus,
  ProductStatus,
  TenantStatus,
  UserStatus,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { SALE_IMMUTABILITY_TRIGGERS, inRolledBackTransaction, saleImmutabilityViolations } from "./table-audit.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";

const APPEND_ONLY = /financial records are never changed or deleted/;
const CLOSED_SESSION = /cash session is closed/;

// M6 schema (migrations 20261110000000_create_cash_and_payments and 20261110010000_adjust_order_immutability) against
// PostgreSQL, as the owner (erp_migrator) and as the runtime identity (erp_app). HTTP rules live in cash-http.int.test.ts.
describe("Cash and payments schema (PostgreSQL)", () => {
  let owner: PrismaClient;
  let app: PrismaClient;

  beforeAll(() => {
    owner = createPrismaClient(inject("databaseUrl"));
    app = createPrismaClient(inject("appDatabaseUrl"));
  });

  afterAll(async () => {
    await owner.$disconnect();
    await app.$disconnect();
  });

  /** Tenant + company + branches A/B + user + product + EDITING order in A + OPEN cash session of the user in A. */
  async function fixture(name = "Caixa") {
    const tenant = await owner.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await owner.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = (code: string) =>
      owner.branch.create({ data: { tenantId: tenant.id, companyId: company.id, name: code, code, status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" } });
    const [a, b] = [await branch("A"), await branch("B")];
    const user = await owner.user.create({ data: { tenantId: tenant.id, name: "Ana", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE } });
    const product = await owner.product.create({ data: { tenantId: tenant.id, name: "X-Burger", basePrice: "25.00", status: ProductStatus.ACTIVE } });
    const order = await owner.order.create({ data: { tenantId: tenant.id, branchId: a.id, status: OrderStatus.EDITING, total: "25.00", createdBy: user.id } });
    await owner.orderItem.create({
      data: { tenantId: tenant.id, orderId: order.id, productId: product.id, productName: "X-Burger", quantity: 1, unitPrice: "25.00", lineTotal: "25.00", sortOrder: 0 },
    });
    const session = await owner.cashSession.create({
      data: { tenantId: tenant.id, branchId: a.id, status: CashSessionStatus.OPEN, openedBy: user.id, openedAt: new Date(), openingAmount: "100.00" },
    });
    return { tenantId: tenant.id, branchA: a.id, branchB: b.id, userId: user.id, orderId: order.id, sessionId: session.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const insertPayment = (
    db: PrismaClient,
    f: Fixture,
    v: Partial<{ branchId: string; sessionId: string; orderId: string; method: string; amount: string; received: string | null; change: string; reference: string | null }> = {},
  ) =>
    db.$executeRaw`INSERT INTO payments (id, tenant_id, branch_id, order_id, cash_session_id, method, amount, received_amount, change, reference)
      VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${v.branchId ?? f.branchA}::uuid, ${v.orderId ?? f.orderId}::uuid, ${v.sessionId ?? f.sessionId}::uuid,
              ${v.method ?? "PIX"}::payment_method, ${v.amount ?? "25.00"}::numeric, ${v.received === undefined ? null : v.received}::numeric,
              ${v.change ?? "0"}::numeric, ${v.reference ?? null})`;

  const insertMovement = (db: PrismaClient, f: Fixture, v: Partial<{ branchId: string; sessionId: string; amount: string; reason: string; type: string }> = {}) =>
    db.$executeRaw`INSERT INTO cash_movements (id, tenant_id, branch_id, cash_session_id, type, amount, reason, created_by)
      VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${v.branchId ?? f.branchA}::uuid, ${v.sessionId ?? f.sessionId}::uuid,
              ${v.type ?? "SUPPLY"}::cash_movement_type, ${v.amount ?? "10.00"}::numeric, ${v.reason ?? "troco"}, ${f.userId}::uuid)`;

  /** Pays the fixture order in cash (received 30, change 5) and confirms it. Returns the payment id. */
  async function payAndConfirm(f: Fixture, method: "CASH" | "PIX" = "CASH"): Promise<string> {
    const id = randomUUID();
    await owner.$executeRaw`INSERT INTO payments (id, tenant_id, branch_id, order_id, cash_session_id, method, amount, received_amount, change)
      VALUES (${id}::uuid, ${f.tenantId}::uuid, ${f.branchA}::uuid, ${f.orderId}::uuid, ${f.sessionId}::uuid, ${method}::payment_method, 25.00,
              ${method === "CASH" ? "30.00" : null}::numeric, ${method === "CASH" ? "5.00" : "0"}::numeric)`;
    await owner.$executeRaw`UPDATE orders SET status = 'CONFIRMED', number = 1, business_date = '2026-11-10', confirmed_at = now() WHERE id = ${f.orderId}::uuid`;
    return id;
  }

  const insertRefund = (
    db: PrismaClient,
    f: Fixture,
    paymentId: string,
    v: Partial<{ method: string; amount: string; sessionId: string | null; orderId: string }> = {},
  ) =>
    db.$executeRaw`INSERT INTO refunds (id, tenant_id, branch_id, payment_id, order_id, method, amount, cash_session_id, created_by)
      VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${f.branchA}::uuid, ${paymentId}::uuid, ${v.orderId ?? f.orderId}::uuid, ${v.method ?? "CASH"}::payment_method,
              ${v.amount ?? "25.00"}::numeric, ${v.sessionId === undefined ? f.sessionId : v.sessionId}::uuid, ${f.userId}::uuid)`;

  const close = (db: PrismaClient, f: Fixture, v: Partial<{ expected: string; counted: string; difference: string; justification: string | null }> = {}) =>
    db.$executeRaw`UPDATE cash_sessions SET status = 'CLOSED', closed_by = opened_by, closed_at = now(), expected_cash = ${v.expected ?? "100.00"}::numeric,
      counted_cash = ${v.counted ?? "100.00"}::numeric, difference = ${v.difference ?? "0"}::numeric, justification = ${v.justification ?? null}, updated_at = now()
      WHERE id = ${f.sessionId}::uuid`;

  describe("columns and enums", () => {
    it("creates the payment, cash session and movement enums with the contract values", async () => {
      const rows = await owner.$queryRaw<{ type: string; labels: string[] }[]>`
        SELECT t.typname::text AS type, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('payment_method', 'cash_session_status', 'cash_movement_type') GROUP BY t.typname`;
      expect(Object.fromEntries(rows.map((r) => [r.type, r.labels]))).toEqual({
        payment_method: ["CASH", "PIX", "DEBIT_CARD", "CREDIT_CARD"],
        cash_session_status: ["OPEN", "CLOSED"],
        cash_movement_type: ["SUPPLY", "WITHDRAWAL"],
      });
    });

    it("stores money as numeric(12,2) (difference may be negative) and carries branch_id on every financial record", async () => {
      const rows = await owner.$queryRaw<{ column: string; type: string }[]>`
        SELECT c.relname || '.' || a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('cash_sessions', 'cash_movements', 'payments', 'refunds') AND a.attnum > 0 AND NOT a.attisdropped`;
      const types = Object.fromEntries(rows.map((r) => [r.column, r.type]));
      for (const c of ["cash_sessions.opening_amount", "cash_sessions.expected_cash", "cash_sessions.difference", "payments.amount", "payments.received_amount", "payments.change", "refunds.amount", "cash_movements.amount"]) {
        expect(types[c], c).toBe("numeric(12,2)");
      }
      for (const t of ["cash_movements", "payments", "refunds"]) expect(types[`${t}.branch_id`], t).toBe("uuid");
    });
  });

  describe("CHECK constraints", () => {
    it.each([
      ["amount 0", { amount: "0" }, "payments_amount_check"],
      ["CASH without received amount", { method: "CASH" }, "payments_method_check"],
      ["CASH with received below amount", { method: "CASH", received: "20.00", change: "0" }, "payments_method_check"],
      ["CASH with wrong change", { method: "CASH", received: "30.00", change: "4.00" }, "payments_method_check"],
      ["PIX with received amount", { received: "25.00" }, "payments_method_check"],
      ["card with change", { method: "DEBIT_CARD", change: "1.00" }, "payments_amount_check|payments_method_check"],
      ["blank reference", { reference: "  " }, "payments_reference_check"],
      ["reference longer than 60", { reference: "x".repeat(61) }, "payments_reference_check"],
    ])("payments rejects %s", async (_, values, constraint) => {
      const f = await fixture();
      await expect(insertPayment(owner, f, values)).rejects.toThrow(new RegExp(constraint));
    });

    it("payments accepts CASH with exact change and cards/PIX with a reference", async () => {
      const f = await fixture();
      expect(await insertPayment(owner, f, { method: "CASH", amount: "10.00", received: "50.00", change: "40.00" })).toBe(1);
      expect(await insertPayment(owner, f, { method: "CASH", amount: "10.00", received: "10.00", change: "0" })).toBe(1);
      expect(await insertPayment(owner, f, { method: "CREDIT_CARD", amount: "5.00", reference: "NSU 123" })).toBe(1);
    });

    it.each([
      ["amount 0", { amount: "0" }, "cash_movements_amount_check"],
      ["reason shorter than 3", { reason: " ab " }, "cash_movements_reason_check"],
      ["reason longer than 200", { reason: "x".repeat(201) }, "cash_movements_reason_check"],
    ])("cash_movements rejects %s", async (_, values, constraint) => {
      const f = await fixture();
      await expect(insertMovement(owner, f, values)).rejects.toThrow(new RegExp(constraint));
    });

    it("cash_sessions: closing fields together, difference = counted − expected, justification when different", async () => {
      const f = await fixture();
      await expect(owner.$executeRaw`UPDATE cash_sessions SET status = 'CLOSED' WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(/cash_sessions_closing_check/);
      await expect(close(owner, f, { counted: "90.00", difference: "-5.00", justification: "faltou" })).rejects.toThrow(/cash_sessions_difference_check/);
      await expect(close(owner, f, { counted: "90.00", difference: "-10.00" })).rejects.toThrow(/cash_sessions_justification_check/);
      await expect(close(owner, f, { counted: "90.00", difference: "-10.00", justification: "ab" })).rejects.toThrow(/cash_sessions_justification_check/);
      await expect(close(owner, f, { counted: "90.00", difference: "-10.00", justification: "x".repeat(501) })).rejects.toThrow(/cash_sessions_justification_check/);
      await expect(owner.$executeRaw`UPDATE cash_sessions SET justification = 'antes' WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(/cash_sessions_closing_check/);
      expect(await close(owner, f, { counted: "90.00", difference: "-10.00", justification: "faltou troco" })).toBe(1);
    });

    it("cash_sessions: opening amount ≥ 0", async () => {
      const f = await fixture();
      await expect(
        owner.$executeRaw`INSERT INTO cash_sessions (id, tenant_id, branch_id, status, opened_by, opened_at, opening_amount, updated_at)
          VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${f.branchB}::uuid, 'OPEN', ${f.userId}::uuid, now(), -1, now())`,
      ).rejects.toThrow(/cash_sessions_amounts_check/);
    });

    it("refunds: CASH <=> cash session; amount, method and order pinned to the payment by the composite FK", async () => {
      const f = await fixture();
      const paymentId = await payAndConfirm(f);
      await expect(insertRefund(owner, f, paymentId, { sessionId: null })).rejects.toThrow(/refunds_cash_session_check/);
      await expect(insertRefund(owner, f, paymentId, { amount: "20.00" })).rejects.toThrow(/refunds_tenant_id_branch_id_payment_id_order_id_method_amo_fkey/);
      await expect(insertRefund(owner, f, paymentId, { method: "PIX", sessionId: null })).rejects.toThrow(/refunds_tenant_id_branch_id_payment_id_order_id_method_amo_fkey/);
      expect(await insertRefund(owner, f, paymentId)).toBe(1);
      await expect(insertRefund(owner, f, paymentId)).rejects.toThrow(/refunds_tenant_id_branch_id_payment_id_order_id_method_amou_key/);
    });
  });

  describe("one OPEN cash session per operator and branch (partial unique index)", () => {
    it("rejects a second OPEN session; another branch, another operator or after closing is fine", async () => {
      const f = await fixture();
      const open = (branchId: string, userId: string) =>
        owner.$executeRaw`INSERT INTO cash_sessions (id, tenant_id, branch_id, status, opened_by, opened_at, opening_amount, updated_at)
          VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${branchId}::uuid, 'OPEN', ${userId}::uuid, now(), 0, now())`;
      await expect(open(f.branchA, f.userId)).rejects.toThrow(/cash_sessions_open_per_operator_key/);
      expect(await open(f.branchB, f.userId)).toBe(1);
      const other = await owner.user.create({ data: { tenantId: f.tenantId, name: "Bia", employeeNumber: "1002", passwordHash: "hash", status: UserStatus.ACTIVE } });
      expect(await open(f.branchA, other.id)).toBe(1);
      await close(owner, f);
      expect(await open(f.branchA, f.userId)).toBe(1);
    });
  });

  describe("composite FKs: no financial record crosses tenant or branch", () => {
    it("a payment cannot use a cash session of another branch or tenant, nor an order of another branch", async () => {
      const f = await fixture("A");
      const other = await fixture("B");
      const sessionB = await owner.cashSession.create({
        data: { tenantId: f.tenantId, branchId: f.branchB, status: CashSessionStatus.OPEN, openedBy: f.userId, openedAt: new Date(), openingAmount: "0" },
      });
      await expect(insertPayment(owner, f, { sessionId: sessionB.id })).rejects.toThrow(/payments_tenant_id_branch_id_cash_session_id_fkey/);
      await expect(insertPayment(owner, f, { branchId: f.branchB, sessionId: sessionB.id })).rejects.toThrow(/payments_tenant_id_branch_id_order_id_fkey/);
      await expect(insertPayment(owner, f, { sessionId: other.sessionId })).rejects.toThrow(/payments_tenant_id_branch_id_cash_session_id_fkey/);
      await expect(insertMovement(owner, f, { sessionId: sessionB.id })).rejects.toThrow(/cash_movements_tenant_id_branch_id_cash_session_id_fkey/);
      await expect(
        owner.$executeRaw`INSERT INTO cash_sessions (id, tenant_id, branch_id, status, opened_by, opened_at, opening_amount, updated_at)
          VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${other.branchA}::uuid, 'OPEN', ${f.userId}::uuid, now(), 0, now())`,
      ).rejects.toThrow(/cash_sessions_tenant_id_branch_id_fkey/);
    });

    it("RESTRICT: a session or order with payments cannot be deleted (the triggers reject it even earlier)", async () => {
      const f = await fixture();
      await payAndConfirm(f);
      await expect(owner.$executeRaw`DELETE FROM users WHERE id = ${f.userId}::uuid`).rejects.toThrow(/fkey/);
      await expect(owner.$executeRaw`DELETE FROM cash_sessions WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(/cash sessions are never deleted/);
    });
  });

  describe("insert guards", () => {
    it("rejects payments and movements in a CLOSED cash session — also as the owner", async () => {
      const f = await fixture();
      await close(app, f);
      for (const db of [app, owner]) {
        await expect(insertPayment(db, f)).rejects.toThrow(CLOSED_SESSION);
        await expect(insertMovement(db, f)).rejects.toThrow(CLOSED_SESSION);
      }
    });

    it("records payments only while the order is EDITING and refunds only for a confirmed, not yet cancelled order", async () => {
      const f = await fixture();
      const draftRefund = await fixture();
      const paymentOfDraft = randomUUID();
      await owner.$executeRaw`INSERT INTO payments (id, tenant_id, branch_id, order_id, cash_session_id, method, amount, change)
        VALUES (${paymentOfDraft}::uuid, ${draftRefund.tenantId}::uuid, ${draftRefund.branchA}::uuid, ${draftRefund.orderId}::uuid, ${draftRefund.sessionId}::uuid, 'PIX', 25.00, 0)`;
      await expect(insertRefund(owner, draftRefund, paymentOfDraft, { method: "PIX", sessionId: null })).rejects.toThrow(/refunds are recorded only while cancelling/);
      const paymentId = await payAndConfirm(f, "PIX");
      await expect(insertPayment(app, f)).rejects.toThrow(/payments are recorded only while confirming an EDITING order/);
      expect(await insertRefund(app, f, paymentId, { method: "PIX", sessionId: null })).toBe(1);
    });
  });

  describe("financial immutability", () => {
    it("payments, refunds and movements are append-only: erp_app has no privilege, the owner hits the trigger", async () => {
      const f = await fixture();
      const paymentId = await payAndConfirm(f);
      await insertRefund(owner, f, paymentId);
      await insertMovement(owner, f);
      for (const table of ["payments", "refunds", "cash_movements"]) {
        await expect(app.$executeRawUnsafe(`UPDATE "${table}" SET amount = amount WHERE tenant_id = $1::uuid`, f.tenantId), table).rejects.toThrow(/permission denied/);
        await expect(app.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1::uuid`, f.tenantId), table).rejects.toThrow(/permission denied/);
        await expect(owner.$executeRawUnsafe(`UPDATE "${table}" SET amount = amount WHERE tenant_id = $1::uuid`, f.tenantId), table).rejects.toThrow(APPEND_ONLY);
        await expect(owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1::uuid`, f.tenantId), table).rejects.toThrow(APPEND_ONLY);
        // tenant_id cannot move either: the append-only trigger fires first.
        await expect(owner.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = gen_random_uuid() WHERE tenant_id = $1::uuid`, f.tenantId), table).rejects.toThrow(APPEND_ONLY);
      }
    });

    it("TRUNCATE is rejected by the guard functions, also for the owner", async () => {
      // Only tables that no FK references, without CASCADE: each locks ONE table, so it cannot deadlock with the other
      // test files running in parallel (TRUNCATE ... CASCADE on orders locks a chain of tables and did deadlock).
      // They exercise both guard functions; the BEFORE TRUNCATE triggers of the referenced tables (payments,
      // cash_sessions, orders, order_items) are pinned by the catalog audit below (statement level, enabled, function).
      for (const table of ["refunds", "cash_movements"]) {
        await expect(owner.$executeRawUnsafe(`TRUNCATE "${table}"`), table).rejects.toThrow(APPEND_ONLY);
      }
      await expect(owner.$executeRawUnsafe(`TRUNCATE "order_item_options"`)).rejects.toThrow(/sales are never deleted/);
      const guarded = Object.entries(SALE_IMMUTABILITY_TRIGGERS).filter(([, t]) => t.events.includes("TRUNCATE")).map(([, t]) => t.table).sort();
      expect(guarded).toEqual(["cash_movements", "cash_sessions", "order_item_options", "order_items", "orders", "payments", "refunds"]);
      await expect(app.$executeRawUnsafe(`TRUNCATE "payments"`)).rejects.toThrow(/permission denied/);
    });

    it("a cash session closes once and is frozen afterwards; while OPEN its identity never changes", async () => {
      const f = await fixture();
      await expect(app.$executeRaw`UPDATE cash_sessions SET opening_amount = 1 WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(/cash session is immutable/);
      await expect(app.$executeRaw`UPDATE cash_sessions SET opened_by = opened_by, branch_id = ${f.branchB}::uuid WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(
        /cash session is immutable|fkey/,
      );
      expect(await close(app, f)).toBe(1);
      for (const db of [app, owner]) {
        await expect(close(db, f, { counted: "50.00", difference: "-50.00", justification: "de novo" })).rejects.toThrow(CLOSED_SESSION);
        await expect(db.$executeRaw`UPDATE cash_sessions SET justification = 'depois' WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(CLOSED_SESSION);
        await expect(db.$executeRaw`UPDATE cash_sessions SET status = 'OPEN', closed_by = NULL, closed_at = NULL, expected_cash = NULL, counted_cash = NULL, difference = NULL WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(
          CLOSED_SESSION,
        );
      }
      await expect(app.$executeRaw`DELETE FROM cash_sessions WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(/permission denied/);
      await expect(owner.$executeRaw`DELETE FROM cash_sessions WHERE id = ${f.sessionId}::uuid`).rejects.toThrow(/cash sessions are never deleted/);
    });

    it("tenant_id of an OPEN cash session is immutable (generic trigger)", async () => {
      const a = await fixture("A");
      const b = await fixture("B");
      await expectTenantIdImmutable(owner.$executeRaw`UPDATE cash_sessions SET tenant_id = ${b.tenantId}::uuid WHERE id = ${a.sessionId}::uuid`, "cash_sessions");
    });
  });

  describe("M5 adjustment: DELIVERED -> CANCELLED", () => {
    it("allows cancelling a delivered order, recording only the cancellation; everything else stays frozen", async () => {
      const f = await fixture();
      await payAndConfirm(f);
      const step = (sql: string) => app.$executeRawUnsafe(sql.replace("$id", f.orderId));
      expect(await step(`UPDATE orders SET status = 'PREPARING', preparing_at = now() WHERE id = '$id'`)).toBe(1);
      expect(await step(`UPDATE orders SET status = 'READY', ready_at = now() WHERE id = '$id'`)).toBe(1);
      expect(await step(`UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = '$id'`)).toBe(1);
      await expect(step(`UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = created_by, cancel_reason = 'x', total = 1 WHERE id = '$id'`)).rejects.toThrow(/order is frozen/);
      await expect(step(`UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = created_by, cancel_reason = 'x', ready_at = now() WHERE id = '$id'`)).rejects.toThrow(/order is frozen/);
      expect(await step(`UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = created_by, cancel_reason = 'estorno total' WHERE id = '$id'`)).toBe(1);
      const order = await owner.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(order).toMatchObject({ status: "CANCELLED", number: 1, cancelReason: "estorno total" });
      expect(order.deliveredAt).not.toBeNull();
    });

    it("a cancellation never records another state's timestamp", async () => {
      const f = await fixture();
      await payAndConfirm(f);
      await expect(
        app.$executeRaw`UPDATE orders SET status = 'CANCELLED', preparing_at = now(), cancelled_at = now(), cancelled_by = created_by, cancel_reason = 'x' WHERE id = ${f.orderId}::uuid`,
      ).rejects.toThrow(/only records its own timestamp/);
    });
  });

  describe("catalog audit of the immutability triggers", () => {
    it("pins every financial trigger", async () => {
      expect(Object.keys(SALE_IMMUTABILITY_TRIGGERS).filter((n) => /^(payments|refunds|cash_)/.test(n)).sort()).toEqual([
        "cash_movements_append_only",
        "cash_movements_insert_guard",
        "cash_movements_no_truncate",
        "cash_sessions_close_once",
        "cash_sessions_no_truncate",
        "payments_append_only",
        "payments_insert_guard",
        "payments_no_truncate",
        "refunds_append_only",
        "refunds_insert_guard",
        "refunds_no_truncate",
      ]);
      expect(await saleImmutabilityViolations(owner)).toEqual([]);
    });

    it.each([
      ["dropped", `DROP TRIGGER payments_append_only ON payments`, ["payments: missing sale immutability trigger payments_append_only"]],
      [
        "disabled (statement level)",
        `ALTER TABLE refunds DISABLE TRIGGER refunds_no_truncate`,
        ["refunds: refunds_no_truncate must be an enabled BEFORE TRUNCATE statement trigger calling forbid_financial_record_mutation()"],
      ],
      [
        "as row trigger instead of statement",
        `DROP TRIGGER orders_no_truncate ON orders; CREATE TRIGGER orders_no_truncate BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_sales_truncate()`,
        ["orders: orders_no_truncate must be an enabled BEFORE TRUNCATE statement trigger calling forbid_sales_truncate()"],
      ],
      [
        "reused on another table",
        `CREATE TRIGGER probe_money BEFORE DELETE ON branches FOR EACH ROW EXECUTE FUNCTION forbid_financial_record_mutation()`,
        ["branches: forbid_financial_record_mutation() used by unexpected trigger probe_money"],
      ],
    ])("probe: a trigger %s is reported", async (_, ddl, expected) => {
      const violations = await inRolledBackTransaction(owner, async (tx) => {
        for (const statement of ddl.split(";")) if (statement.trim()) await tx.$executeRawUnsafe(statement);
        return saleImmutabilityViolations(tx);
      });
      expect(violations).toEqual(expected);
    });
  });
});
