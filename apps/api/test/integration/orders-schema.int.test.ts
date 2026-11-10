import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BranchStatus, CompanyStatus, OrderStatus, ProductStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { SALE_IMMUTABILITY_TRIGGERS, inRolledBackTransaction, saleImmutabilityViolations } from "./table-audit.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";

const M5_TABLES = ["orders", "order_items", "order_item_options", "branch_order_counters"] as const;
const NOT_EDITABLE = /order is not editable/;
const FROZEN = /order is frozen/;
const INVALID_TRANSITION = /invalid order transition/;

// M5 schema (migration 20261109000000_create_orders) against PostgreSQL: CHECKs, uniques, composite FKs, RESTRICT and the
// sale immutability triggers, as the owner (erp_migrator) and as the runtime identity (erp_app). HTTP rules live in
// orders-http.int.test.ts.
describe("Orders schema (PostgreSQL)", () => {
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

  /** Tenant + company + branch + user + product + an EDITING order with one item and one option. */
  async function newOrder(name = "Pedido") {
    const tenant = await owner.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await owner.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = await owner.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: "Loja", code: "LOJA", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const user = await owner.user.create({ data: { tenantId: tenant.id, name: "Ana", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE } });
    const product = await owner.product.create({ data: { tenantId: tenant.id, name: "X-Burger", code: "XB", basePrice: "25.00", status: ProductStatus.ACTIVE } });
    const order = await owner.order.create({
      data: { tenantId: tenant.id, branchId: branch.id, status: OrderStatus.EDITING, total: "29.00", createdBy: user.id },
    });
    const item = await owner.orderItem.create({
      data: { tenantId: tenant.id, orderId: order.id, productId: product.id, productName: "X-Burger", productCode: "XB", quantity: 1, unitPrice: "29.00", lineTotal: "29.00", sortOrder: 0 },
    });
    const option = await owner.orderItemOption.create({
      data: { tenantId: tenant.id, orderItemId: item.id, optionId: randomUUID(), groupName: "Tamanho", name: "G", priceDelta: "4.00", sortOrder: 0 },
    });
    return { tenantId: tenant.id, branchId: branch.id, userId: user.id, productId: product.id, orderId: order.id, itemId: item.id, optionId: option.id };
  }
  type Fixture = Awaited<ReturnType<typeof newOrder>>;

  const confirm = (db: PrismaClient, f: Fixture, number = 1) =>
    db.$executeRaw`UPDATE orders SET status = 'CONFIRMED', number = ${number}, business_date = '2026-11-09', confirmed_at = now(), updated_at = now()
      WHERE tenant_id = ${f.tenantId}::uuid AND id = ${f.orderId}::uuid`;

  const insertOrder = (
    tenantId: string,
    branchId: string,
    userId: string,
    v: Partial<{ status: string; number: number | null; businessDate: string | null; confirmed: boolean; total: string; cancelledBy: string | null; reason: string | null; cancelled: boolean }> = {},
  ) =>
    owner.$executeRaw`INSERT INTO orders (id, tenant_id, branch_id, status, number, business_date, total, created_by, confirmed_at, cancelled_at, cancelled_by, cancel_reason, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${branchId}::uuid, ${v.status ?? "EDITING"}::order_status, ${v.number ?? null}::int, ${v.businessDate ?? null}::date,
              ${v.total ?? "0"}::numeric, ${userId}::uuid, ${v.confirmed ? new Date() : null}::timestamptz, ${v.cancelled ? new Date() : null}::timestamptz,
              ${v.cancelledBy ?? null}::uuid, ${v.reason ?? null}, now())`;

  const insertItem = (
    db: PrismaClient,
    f: Pick<Fixture, "tenantId" | "orderId" | "productId">,
    v: Partial<{ quantity: number; unitPrice: string; lineTotal: string; name: string; code: string | null; note: string | null; sortOrder: number }> = {},
  ) =>
    db.$executeRaw`INSERT INTO order_items (id, tenant_id, order_id, product_id, product_name, product_code, quantity, unit_price, line_total, note, sort_order, updated_at)
      VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${f.orderId}::uuid, ${f.productId}::uuid, ${v.name ?? "Suco"}, ${v.code ?? null}, ${v.quantity ?? 2},
              ${v.unitPrice ?? "5.00"}::numeric, ${v.lineTotal ?? "10.00"}::numeric, ${v.note ?? null}, ${v.sortOrder ?? 1}, now())`;

  const insertOption = (
    db: PrismaClient,
    f: Pick<Fixture, "tenantId" | "itemId">,
    v: Partial<{ optionId: string; group: string; name: string; priceDelta: string; sortOrder: number }> = {},
  ) =>
    db.$executeRaw`INSERT INTO order_item_options (id, tenant_id, order_item_id, option_id, group_name, name, price_delta, sort_order, updated_at)
      VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${f.itemId}::uuid, ${v.optionId ?? randomUUID()}::uuid, ${v.group ?? "Extras"}, ${v.name ?? "Bacon"},
              ${v.priceDelta ?? "4.00"}::numeric, ${v.sortOrder ?? 1}, now())`;

  describe("columns", () => {
    it("stores money as numeric(12,2), the business day as date and state timestamps as timestamptz(3)", async () => {
      const rows = await owner.$queryRaw<{ column: string; type: string }[]>`
        SELECT c.relname || '.' || a.attname AS "column", format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN '' ELSE ' NULL' END AS type
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY(${[...M5_TABLES]}::text[]) AND a.attnum > 0 AND NOT a.attisdropped`;
      const types = Object.fromEntries(rows.map((r) => [r.column, r.type]));
      expect(types).toMatchObject({
        "orders.status": "order_status",
        "orders.number": "integer NULL",
        "orders.business_date": "date NULL",
        "orders.total": "numeric(12,2)",
        "orders.created_by": "uuid",
        "orders.confirmed_at": "timestamp(3) with time zone NULL",
        "orders.cancelled_by": "uuid NULL",
        "orders.cancel_reason": "text NULL",
        "order_items.quantity": "integer",
        "order_items.unit_price": "numeric(12,2)",
        "order_items.line_total": "numeric(12,2)",
        "order_items.product_code": "text NULL",
        "order_items.note": "text NULL",
        "order_item_options.option_id": "uuid",
        "order_item_options.price_delta": "numeric(12,2)",
        "order_item_options.linked_product_id": "uuid NULL",
        "branch_order_counters.business_date": "date",
        "branch_order_counters.last_number": "integer",
      });
      expect(Object.keys(types).filter((c) => c.endsWith(".tenant_id"))).toHaveLength(4);
    });

    it("creates the order_status enum with exactly the contract states", async () => {
      const labels = await owner.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'order_status' ORDER BY e.enumsortorder`;
      expect(labels.map((l) => l.label)).toEqual(["EDITING", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "CANCELLED"]);
    });

    it("keeps option_id without FK (historical reference) and product_id with FK", async () => {
      const f = await newOrder();
      expect(await insertOption(owner, f, { optionId: randomUUID() })).toBe(1);
      await expect(insertItem(owner, { ...f, productId: randomUUID() })).rejects.toThrow(/order_items_tenant_id_product_id_fkey/);
    });
  });

  describe("CHECK constraints", () => {
    it.each([
      ["quantity 0", { quantity: 0, lineTotal: "0.00" }, "order_items_quantity_check"],
      ["quantity 100", { quantity: 100, lineTotal: "500.00" }, "order_items_quantity_check"],
      ["line_total different from unit_price × quantity", { lineTotal: "10.01" }, "order_items_line_total_check"],
      ["negative unit price", { unitPrice: "-5.00", lineTotal: "-10.00" }, "order_items_unit_price_check"],
      ["blank product name", { name: " " }, "order_items_product_name_check"],
      ["lowercase product code", { code: "xb" }, "order_items_product_code_check"],
      ["blank note", { note: "  " }, "order_items_note_check"],
      ["note longer than 140", { note: "x".repeat(141) }, "order_items_note_check"],
      ["sort_order above 99", { sortOrder: 100 }, "order_items_sort_order_check"],
    ])("order_items rejects %s", async (_, values, constraint) => {
      const f = await newOrder();
      await expect(insertItem(owner, f, values)).rejects.toThrow(new RegExp(constraint));
    });

    it("order_items accepts the boundaries (quantity 1 and 99, note of 140)", async () => {
      const f = await newOrder();
      expect(await insertItem(owner, f, { quantity: 99, unitPrice: "0.10", lineTotal: "9.90", note: "x".repeat(140), sortOrder: 99 })).toBe(1);
      expect(await insertItem(owner, f, { quantity: 1, unitPrice: "0.10", lineTotal: "0.10", sortOrder: 2 })).toBe(1);
    });

    it.each([
      ["blank group name", { group: "" }, "order_item_options_group_name_check"],
      ["blank name", { name: " " }, "order_item_options_name_check"],
      ["negative price_delta", { priceDelta: "-0.01" }, "order_item_options_price_delta_check"],
      ["sort_order above 999", { sortOrder: 1000 }, "order_item_options_sort_order_check"],
    ])("order_item_options rejects %s", async (_, values, constraint) => {
      const f = await newOrder();
      await expect(insertOption(owner, f, values)).rejects.toThrow(new RegExp(constraint));
    });

    it("orders: number ≥ 1, number/business_date/confirmed_at together, total ≥ 0", async () => {
      const f = await newOrder();
      const base = { status: "CONFIRMED", businessDate: "2026-11-09", confirmed: true };
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { ...base, number: 0 })).rejects.toThrow(/orders_number_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { ...base, number: 1, businessDate: null })).rejects.toThrow(/orders_confirmation_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { number: 1, businessDate: "2026-11-09" })).rejects.toThrow(/orders_confirmation_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { total: "-0.01" })).rejects.toThrow(/orders_total_check/);
    });

    it("orders: timestamps must match the status", async () => {
      const f = await newOrder();
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { status: "PREPARING", number: 1, businessDate: "2026-11-09", confirmed: true })).rejects.toThrow(
        /orders_status_check/,
      );
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { status: "EDITING", cancelled: true })).rejects.toThrow(/orders_status_check/);
    });

    it("orders: canceller only when cancelled; reason required after confirmation, 1..200 non-blank", async () => {
      const f = await newOrder();
      const confirmedCancel = { status: "CANCELLED", number: 1, businessDate: "2026-11-09", confirmed: true, cancelled: true, cancelledBy: f.userId };
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { status: "CANCELLED", cancelled: true })).rejects.toThrow(/orders_cancellation_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, confirmedCancel)).rejects.toThrow(/orders_cancellation_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { reason: "motivo" })).rejects.toThrow(/orders_cancellation_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { ...confirmedCancel, reason: "x".repeat(201) })).rejects.toThrow(/orders_cancel_reason_check/);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { ...confirmedCancel, reason: "   " })).rejects.toThrow(/orders_cancel_reason_check/);
      expect(await insertOrder(f.tenantId, f.branchId, f.userId, { ...confirmedCancel, number: 2, reason: "cliente desistiu" })).toBe(1);
      // A discarded draft (never confirmed) may be cancelled without reason.
      expect(await insertOrder(f.tenantId, f.branchId, f.userId, { status: "CANCELLED", cancelled: true, cancelledBy: f.userId })).toBe(1);
    });

    it("branch_order_counters: last_number ≥ 1", async () => {
      const f = await newOrder();
      await expect(
        owner.$executeRaw`INSERT INTO branch_order_counters (id, tenant_id, branch_id, business_date, last_number, updated_at)
          VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${f.branchId}::uuid, '2026-11-09', 0, now())`,
      ).rejects.toThrow(/branch_order_counters_last_number_check/);
    });
  });

  describe("uniques and the atomic counter", () => {
    it("the number is unique per branch and business day; drafts (NULL) never collide", async () => {
      const f = await newOrder();
      const day = { status: "CONFIRMED", businessDate: "2026-11-09", confirmed: true };
      expect(await insertOrder(f.tenantId, f.branchId, f.userId, { ...day, number: 7 })).toBe(1);
      await expect(insertOrder(f.tenantId, f.branchId, f.userId, { ...day, number: 7 })).rejects.toThrow(/orders_tenant_id_branch_id_business_date_number_key/);
      expect(await insertOrder(f.tenantId, f.branchId, f.userId, { ...day, number: 7, businessDate: "2026-11-10" })).toBe(1);
      const other = await owner.branch.create({
        data: { tenantId: f.tenantId, companyId: (await owner.branch.findUniqueOrThrow({ where: { id: f.branchId } })).companyId, name: "B", code: "B", status: BranchStatus.ACTIVE, timezone: "America/Manaus" },
      });
      expect(await insertOrder(f.tenantId, other.id, f.userId, { ...day, number: 7 })).toBe(1);
      expect(await insertOrder(f.tenantId, f.branchId, f.userId)).toBe(1);
      expect(await insertOrder(f.tenantId, f.branchId, f.userId)).toBe(1);
    });

    it("an option appears at most once per item, and one item per position", async () => {
      const f = await newOrder();
      const optionId = randomUUID();
      expect(await insertOption(owner, f, { optionId, sortOrder: 1 })).toBe(1);
      await expect(insertOption(owner, f, { optionId, sortOrder: 2 })).rejects.toThrow(/order_item_options_tenant_id_order_item_id_option_id_key/);
      await expect(insertOption(owner, f, { sortOrder: 0 })).rejects.toThrow(/order_item_options_tenant_id_order_item_id_sort_order_key/);
      await expect(insertItem(owner, f, { sortOrder: 0 })).rejects.toThrow(/order_items_tenant_id_order_id_sort_order_key/);
    });

    it("INSERT ... ON CONFLICT increments the counter atomically, also as erp_app", async () => {
      const f = await newOrder();
      const next = async () => {
        const [row] = await app.$queryRaw<{ n: number }[]>`
          INSERT INTO branch_order_counters (id, tenant_id, branch_id, business_date, last_number, created_at, updated_at)
          VALUES (gen_random_uuid(), ${f.tenantId}::uuid, ${f.branchId}::uuid, '2026-11-09', 1, now(), now())
          ON CONFLICT (tenant_id, branch_id, business_date) DO UPDATE SET last_number = branch_order_counters.last_number + 1, updated_at = now()
          RETURNING last_number AS n`;
        return row!.n;
      };
      expect((await Promise.all(Array.from({ length: 10 }, next))).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  describe("composite FKs: nothing points across tenants", () => {
    it("rejects an order of tenant A on a branch or user of tenant B", async () => {
      const a = await newOrder("A");
      const b = await newOrder("B");
      await expect(insertOrder(a.tenantId, b.branchId, a.userId)).rejects.toThrow(/orders_tenant_id_branch_id_fkey/);
      await expect(insertOrder(a.tenantId, a.branchId, b.userId)).rejects.toThrow(/orders_tenant_id_created_by_fkey/);
      await expect(
        insertOrder(a.tenantId, a.branchId, a.userId, { status: "CANCELLED", cancelled: true, cancelledBy: b.userId }),
      ).rejects.toThrow(/orders_tenant_id_cancelled_by_fkey/);
    });

    it("rejects an item on another tenant's order or product, an option on another tenant's item and a foreign counter", async () => {
      const a = await newOrder("A");
      const b = await newOrder("B");
      await expect(insertItem(owner, { tenantId: a.tenantId, orderId: b.orderId, productId: a.productId })).rejects.toThrow(/order_items_tenant_id_order_id_fkey/);
      await expect(insertItem(owner, { tenantId: a.tenantId, orderId: a.orderId, productId: b.productId })).rejects.toThrow(/order_items_tenant_id_product_id_fkey/);
      await expect(insertOption(owner, { tenantId: a.tenantId, itemId: b.itemId })).rejects.toThrow(/order_item_options_tenant_id_order_item_id_fkey/);
      await expect(
        owner.$executeRaw`INSERT INTO branch_order_counters (id, tenant_id, branch_id, business_date, last_number, updated_at)
          VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${b.branchId}::uuid, '2026-11-09', 1, now())`,
      ).rejects.toThrow(/branch_order_counters_tenant_id_branch_id_fkey/);
    });

    it("RESTRICT: branch, user, product and item referenced by an order cannot be deleted", async () => {
      const f = await newOrder();
      await expect(owner.$executeRaw`DELETE FROM branches WHERE id = ${f.branchId}::uuid`).rejects.toThrow(/orders_tenant_id_branch_id_fkey/);
      await expect(owner.$executeRaw`DELETE FROM users WHERE id = ${f.userId}::uuid`).rejects.toThrow(/orders_tenant_id_created_by_fkey/);
      await expect(owner.$executeRaw`DELETE FROM products WHERE id = ${f.productId}::uuid`).rejects.toThrow(/order_items_tenant_id_product_id_fkey/);
      await expect(owner.$executeRaw`DELETE FROM order_items WHERE id = ${f.itemId}::uuid`).rejects.toThrow(/order_item_options_tenant_id_order_item_id_fkey/);
    });
  });

  describe("sale immutability (triggers + privileges)", () => {
    it("while EDITING, erp_app replaces items and options and updates the total", async () => {
      const f = await newOrder();
      expect(await app.$executeRaw`DELETE FROM order_item_options WHERE tenant_id = ${f.tenantId}::uuid AND order_item_id = ${f.itemId}::uuid`).toBe(1);
      expect(await app.$executeRaw`DELETE FROM order_items WHERE tenant_id = ${f.tenantId}::uuid AND order_id = ${f.orderId}::uuid`).toBe(1);
      expect(await insertItem(app, f, { sortOrder: 0 })).toBe(1);
      expect(await app.$executeRaw`UPDATE orders SET total = 10.00, updated_at = now() WHERE tenant_id = ${f.tenantId}::uuid AND id = ${f.orderId}::uuid`).toBe(1);
    });

    it("after confirmation, items and options cannot be inserted, changed or deleted — by erp_app or by the owner", async () => {
      const f = await newOrder();
      expect(await confirm(app, f)).toBe(1);
      for (const db of [app, owner]) {
        await expect(insertItem(db, f, { sortOrder: 5 })).rejects.toThrow(NOT_EDITABLE);
        await expect(insertOption(db, f, { sortOrder: 5 })).rejects.toThrow(NOT_EDITABLE);
        await expect(db.$executeRaw`DELETE FROM order_item_options WHERE id = ${f.optionId}::uuid`).rejects.toThrow(NOT_EDITABLE);
        await expect(db.$executeRaw`DELETE FROM order_items WHERE id = ${f.itemId}::uuid`).rejects.toThrow(NOT_EDITABLE);
      }
      // erp_app has no UPDATE on lines at all; the owner hits the trigger.
      await expect(app.$executeRaw`UPDATE order_items SET quantity = 2, line_total = 58.00 WHERE id = ${f.itemId}::uuid`).rejects.toThrow(/permission denied/);
      await expect(owner.$executeRaw`UPDATE order_items SET quantity = 2, line_total = 58.00 WHERE id = ${f.itemId}::uuid`).rejects.toThrow(NOT_EDITABLE);
      await expect(owner.$executeRaw`UPDATE order_item_options SET price_delta = 0 WHERE id = ${f.optionId}::uuid`).rejects.toThrow(NOT_EDITABLE);
      expect(await owner.orderItem.findUniqueOrThrow({ where: { id: f.itemId } })).toMatchObject({ quantity: 1 });
    });

    it("after confirmation, total, number, business day, branch and author are frozen", async () => {
      const f = await newOrder();
      await confirm(app, f);
      for (const db of [app, owner]) {
        await expect(db.$executeRaw`UPDATE orders SET total = 1.00 WHERE id = ${f.orderId}::uuid`).rejects.toThrow(FROZEN);
        await expect(db.$executeRaw`UPDATE orders SET number = 99 WHERE id = ${f.orderId}::uuid`).rejects.toThrow(FROZEN);
        await expect(db.$executeRaw`UPDATE orders SET business_date = '2026-01-01' WHERE id = ${f.orderId}::uuid`).rejects.toThrow(FROZEN);
        await expect(db.$executeRaw`UPDATE orders SET created_by = created_by, branch_id = gen_random_uuid() WHERE id = ${f.orderId}::uuid`).rejects.toThrow(/order is immutable/);
      }
      expect(await owner.order.findUniqueOrThrow({ where: { id: f.orderId } })).toMatchObject({ number: 1, status: OrderStatus.CONFIRMED });
    });

    it("only the contract transitions are accepted; recorded state timestamps never change", async () => {
      const f = await newOrder();
      await confirm(app, f);
      await expect(app.$executeRaw`UPDATE orders SET status = 'READY', preparing_at = now(), ready_at = now() WHERE id = ${f.orderId}::uuid`).rejects.toThrow(INVALID_TRANSITION);
      await expect(app.$executeRaw`UPDATE orders SET status = 'EDITING', number = NULL, business_date = NULL, confirmed_at = NULL WHERE id = ${f.orderId}::uuid`).rejects.toThrow(
        INVALID_TRANSITION,
      );
      expect(await app.$executeRaw`UPDATE orders SET status = 'PREPARING', preparing_at = now() WHERE id = ${f.orderId}::uuid`).toBe(1);
      await expect(app.$executeRaw`UPDATE orders SET preparing_at = now() - interval '1 hour' WHERE id = ${f.orderId}::uuid`).rejects.toThrow(FROZEN);
      expect(await app.$executeRaw`UPDATE orders SET status = 'READY', ready_at = now() WHERE id = ${f.orderId}::uuid`).toBe(1);
      expect(await app.$executeRaw`UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = ${f.orderId}::uuid`).toBe(1);
      await expect(
        app.$executeRaw`UPDATE orders SET status = 'CANCELLED', delivered_at = NULL, cancelled_at = now(), cancelled_by = created_by, cancel_reason = 'tarde' WHERE id = ${f.orderId}::uuid`,
      ).rejects.toThrow(INVALID_TRANSITION);
    });

    it("a cancelled order is terminal", async () => {
      const f = await newOrder();
      expect(
        await app.$executeRaw`UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = created_by WHERE id = ${f.orderId}::uuid`,
      ).toBe(1);
      await expect(
        app.$executeRaw`UPDATE orders SET status = 'CONFIRMED', cancelled_at = NULL, cancelled_by = NULL, number = 1, business_date = '2026-11-09', confirmed_at = now() WHERE id = ${f.orderId}::uuid`,
      ).rejects.toThrow(INVALID_TRANSITION);
      await expect(app.$executeRaw`UPDATE orders SET cancel_reason = 'depois' WHERE id = ${f.orderId}::uuid`).rejects.toThrow(FROZEN);
      // A cancelled draft keeps its lines frozen too.
      await expect(insertItem(app, f, { sortOrder: 5 })).rejects.toThrow(NOT_EDITABLE);
    });

    it("orders are never deleted: no DELETE privilege for erp_app, and the trigger rejects it for the owner (even drafts)", async () => {
      const f = await newOrder();
      await expect(app.$executeRaw`DELETE FROM orders WHERE id = ${f.orderId}::uuid`).rejects.toThrow(/permission denied/);
      await expect(owner.$executeRaw`DELETE FROM orders WHERE id = ${f.orderId}::uuid`).rejects.toThrow(/orders are never deleted/);
      expect(await owner.order.count({ where: { id: f.orderId } })).toBe(1);
    });

    it("the catalog audit pins the sale immutability triggers", async () => {
      expect(Object.keys(SALE_IMMUTABILITY_TRIGGERS).sort()).toEqual(["order_item_options_editing_only", "order_items_editing_only", "orders_immutable_after_confirmation"]);
      expect(await saleImmutabilityViolations(owner)).toEqual([]);
    });

    it.each([
      ["dropped", `DROP TRIGGER order_items_editing_only ON order_items`, ["order_items: missing sale immutability trigger order_items_editing_only"]],
      [
        "disabled",
        `ALTER TABLE orders DISABLE TRIGGER orders_immutable_after_confirmation`,
        ["orders: orders_immutable_after_confirmation must be an enabled BEFORE UPDATE OR DELETE row trigger calling forbid_order_mutation_after_confirmation()"],
      ],
      [
        "without DELETE",
        `DROP TRIGGER order_item_options_editing_only ON order_item_options;
         CREATE TRIGGER order_item_options_editing_only BEFORE INSERT OR UPDATE ON order_item_options FOR EACH ROW EXECUTE FUNCTION forbid_order_line_change_unless_editing()`,
        ["order_item_options: order_item_options_editing_only must be an enabled BEFORE INSERT OR UPDATE OR DELETE row trigger calling forbid_order_line_change_unless_editing()"],
      ],
      [
        "reused elsewhere",
        `CREATE TRIGGER probe_lines BEFORE DELETE ON branch_order_counters FOR EACH ROW EXECUTE FUNCTION forbid_order_line_change_unless_editing()`,
        ["branch_order_counters: forbid_order_line_change_unless_editing() used by unexpected trigger probe_lines"],
      ],
    ])("probe: a trigger %s is reported", async (_, ddl, expected) => {
      const violations = await inRolledBackTransaction(owner, async (tx) => {
        for (const statement of ddl.split(";")) if (statement.trim()) await tx.$executeRawUnsafe(statement);
        return saleImmutabilityViolations(tx);
      });
      expect(violations).toEqual(expected);
    });
  });

  describe("tenant_id is immutable on every M5 table", () => {
    it.each(M5_TABLES)("%s", async (table) => {
      const a = await newOrder("A");
      const b = await newOrder("B");
      if (table === "branch_order_counters") {
        await owner.branchOrderCounter.create({ data: { tenantId: a.tenantId, branchId: a.branchId, businessDate: new Date("2026-11-09T00:00:00.000Z"), lastNumber: 1 } });
      }
      const [row] = await owner.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM "${table}" WHERE tenant_id = $1::uuid LIMIT 1`, a.tenantId);
      await expectTenantIdImmutable(owner.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = $1::uuid WHERE id = $2::uuid`, b.tenantId, row!.id), table);
    });
  });
});
