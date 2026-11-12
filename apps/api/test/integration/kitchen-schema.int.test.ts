import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  KitchenSectorStatus,
  OrderStatus,
  ProductStatus,
  TenantStatus,
  UserStatus,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { SALE_IMMUTABILITY_TRIGGERS, saleImmutabilityViolations } from "./table-audit.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";

// M7 schema (migration 20261110020000_create_kitchen) against PostgreSQL, as the owner (erp_migrator) and as the runtime
// identity (erp_app). HTTP rules live in kitchen-http.int.test.ts; the incremental path in kitchen-migration.int.test.ts.
describe("Kitchen schema (PostgreSQL)", () => {
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

  /** Tenant + branches A/B + user + default sector + BAR + two CONFIRMED orders in A (one item each) + an EDITING order. */
  async function fixture(name = "Cozinha schema") {
    const tenant = await owner.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await owner.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = (code: string) =>
      owner.branch.create({ data: { tenantId: tenant.id, companyId: company.id, name: code, code, status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" } });
    const [a, b] = [await branch("A"), await branch("B")];
    const user = await owner.user.create({ data: { tenantId: tenant.id, name: "Ana", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE } });
    const sector = (code: string, isDefault: boolean) =>
      owner.kitchenSector.create({ data: { tenantId: tenant.id, name: code, code, isDefault, status: KitchenSectorStatus.ACTIVE } });
    const [cozinha, bar] = [await sector("COZINHA", true), await sector("BAR", false)];
    const product = await owner.product.create({ data: { tenantId: tenant.id, name: "X-Burger", basePrice: "25.00", status: ProductStatus.ACTIVE } });
    const order = async (number: number | null) => {
      const created = await owner.order.create({ data: { tenantId: tenant.id, branchId: a.id, status: OrderStatus.EDITING, total: "25.00", createdBy: user.id } });
      const item = await owner.orderItem.create({
        data: { tenantId: tenant.id, orderId: created.id, productId: product.id, productName: "X-Burger", quantity: 1, unitPrice: "25.00", lineTotal: "25.00", sortOrder: 0 },
      });
      if (number !== null) {
        await owner.$executeRaw`UPDATE orders SET status = 'CONFIRMED', number = ${number}, business_date = '2026-11-10', confirmed_at = now() WHERE id = ${created.id}::uuid`;
      }
      return { id: created.id, itemId: item.id };
    };
    return { tenantId: tenant.id, branchA: a.id, branchB: b.id, cozinha: cozinha.id, bar: bar.id, confirmed: await order(1), other: await order(2), editing: await order(null) };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const insertTicket = (db: PrismaClient, f: Fixture, v: Partial<{ id: string; orderId: string; branchId: string; sectorId: string; status: string; prints: number }> = {}) =>
    db.$executeRaw`INSERT INTO kitchen_tickets (id, tenant_id, branch_id, order_id, sector_id, sector_name, sector_code, status, started_at, print_count, last_printed_at, updated_at)
      VALUES (${v.id ?? randomUUID()}::uuid, ${f.tenantId}::uuid, ${v.branchId ?? f.branchA}::uuid, ${v.orderId ?? f.confirmed.id}::uuid, ${v.sectorId ?? f.cozinha}::uuid,
              'Cozinha', 'COZINHA', ${v.status ?? "WAITING"}::kitchen_ticket_status, ${v.status === "PREPARING" ? new Date() : null},
              ${v.prints ?? 0}, ${v.prints ? new Date() : null}, now())`;

  const insertItem = (db: PrismaClient, f: Fixture, ticketId: string, v: Partial<{ orderId: string; itemId: string }> = {}) =>
    db.$executeRaw`INSERT INTO kitchen_ticket_items (id, tenant_id, order_id, ticket_id, order_item_id)
      VALUES (${randomUUID()}::uuid, ${f.tenantId}::uuid, ${v.orderId ?? f.confirmed.id}::uuid, ${ticketId}::uuid, ${v.itemId ?? f.confirmed.itemId}::uuid)`;

  /** A WAITING ticket of the confirmed order with its item, as the confirmation creates it. */
  async function ticketWithItem(f: Fixture): Promise<string> {
    const id = randomUUID();
    await insertTicket(owner, f, { id });
    await insertItem(owner, f, id);
    return id;
  }

  describe("sectors", () => {
    it("allows at most one default per tenant; the default is always ACTIVE; code and name follow the rules", async () => {
      const f = await fixture("Setor padrão");
      await expect(owner.kitchenSector.create({ data: { tenantId: f.tenantId, name: "Outro", code: "OUTRO", isDefault: true, status: KitchenSectorStatus.ACTIVE } })).rejects.toThrow(
        /kitchen_sectors_one_default_per_tenant_key|Unique constraint/,
      );
      await expect(owner.$executeRaw`UPDATE kitchen_sectors SET status = 'INACTIVE' WHERE id = ${f.cozinha}::uuid`).rejects.toThrow(/kitchen_sectors_default_active_check/);
      for (const [code, name] of [["bar 2", "Bar"], ["-BAR", "Bar"], ["OK", " "], ["OK2", "x".repeat(61)]]) {
        await expect(owner.kitchenSector.create({ data: { tenantId: f.tenantId, name: name!, code: code!, isDefault: false, status: KitchenSectorStatus.ACTIVE } }), code).rejects.toThrow(/check/i);
      }
      // Another tenant has its own default.
      const g = await fixture("Setor padrão 2");
      expect(await owner.kitchenSector.count({ where: { tenantId: { in: [f.tenantId, g.tenantId] }, isDefault: true } })).toBe(2);
    });

    it("keeps tenant_id immutable on the four kitchen tables", async () => {
      const f = await fixture("Imutável A");
      const g = await fixture("Imutável B");
      const ticket = await ticketWithItem(f);
      await owner.$executeRaw`INSERT INTO branch_kitchen_sectors (id, tenant_id, branch_id, sector_id, enabled, updated_at) VALUES (${randomUUID()}::uuid, ${f.tenantId}::uuid, ${f.branchA}::uuid, ${f.bar}::uuid, false, now())`;
      await expectTenantIdImmutable(owner.$executeRaw`UPDATE kitchen_sectors SET tenant_id = ${g.tenantId}::uuid WHERE id = ${f.bar}::uuid`, "kitchen_sectors");
      await expectTenantIdImmutable(owner.$executeRaw`UPDATE branch_kitchen_sectors SET tenant_id = ${g.tenantId}::uuid WHERE tenant_id = ${f.tenantId}::uuid`, "branch_kitchen_sectors");
      await expectTenantIdImmutable(owner.$executeRaw`UPDATE kitchen_tickets SET tenant_id = ${g.tenantId}::uuid WHERE id = ${ticket}::uuid`, "kitchen_tickets");
      await expect(owner.$executeRaw`UPDATE kitchen_ticket_items SET tenant_id = ${g.tenantId}::uuid WHERE ticket_id = ${ticket}::uuid`).rejects.toThrow();
    });
  });

  describe("tickets", () => {
    it("are born WAITING, unprinted, with the order CONFIRMED", async () => {
      const f = await fixture("Nascimento");
      await expect(insertTicket(owner, f, { orderId: f.editing.id })).rejects.toThrow(/created on confirmation: order is EDITING/);
      await expect(insertTicket(owner, f, { status: "PREPARING" })).rejects.toThrow(/created WAITING and never printed/);
      await expect(insertTicket(owner, f, { prints: 1 })).rejects.toThrow(/created WAITING and never printed/);
      await insertTicket(owner, f);
      await expect(insertTicket(owner, f)).rejects.toThrow(/kitchen_tickets_tenant_id_order_id_sector_id_key|Unique/);
    });

    it("belong to the order's branch and to a sector of the same tenant (composite FKs)", async () => {
      const f = await fixture("FK comanda");
      const g = await fixture("FK comanda outro");
      await expect(insertTicket(owner, f, { branchId: f.branchB })).rejects.toThrow(/kitchen_tickets_tenant_id_branch_id_order_id_fkey/);
      await expect(insertTicket(owner, f, { sectorId: g.cozinha })).rejects.toThrow(/kitchen_tickets_tenant_id_sector_id_fkey/);
    });

    it("are never deleted or truncated; identity and sector copies never change", async () => {
      const f = await fixture("Comanda imutável");
      const ticket = await ticketWithItem(f);
      await expect(owner.$executeRaw`DELETE FROM kitchen_tickets WHERE id = ${ticket}::uuid`).rejects.toThrow(/kitchen tickets are never deleted/);
      await expect(owner.$executeRawUnsafe(`TRUNCATE "kitchen_ticket_items"`)).rejects.toThrow(/sales are never deleted/);
      for (const set of ["sector_name = 'Outro'", "sector_code = 'OUTRO'", `sector_id = '${f.bar}'`, "created_at = now() - interval '1 day'"]) {
        await expect(owner.$executeRawUnsafe(`UPDATE kitchen_tickets SET ${set} WHERE id = '${ticket}'`), set).rejects.toThrow(/kitchen ticket is immutable/);
      }
    });

    it("only move along WAITING>PREPARING>READY (or WAITING>READY), any open state>CANCELLED; recorded timestamps never change", async () => {
      const f = await fixture("Transições comanda");
      const ticket = await ticketWithItem(f);
      const set = (sql: string) => owner.$executeRawUnsafe(`UPDATE kitchen_tickets SET ${sql} WHERE id = '${ticket}'`);
      await expect(set("status = 'PREPARING'")).rejects.toThrow(/kitchen_tickets_status_check/);
      await expect(set("started_at = now()")).rejects.toThrow(/kitchen ticket is frozen/);
      await set("status = 'PREPARING', started_at = now()");
      await expect(set("status = 'WAITING', started_at = NULL")).rejects.toThrow(/invalid kitchen ticket transition: PREPARING -> WAITING/);
      await expect(set("status = 'READY', ready_at = now(), started_at = now() + interval '1 minute'")).rejects.toThrow(/only records its own timestamp/);
      await expect(set("status = 'READY', ready_at = now(), print_count = 1, last_printed_at = now()")).rejects.toThrow(/only records its own timestamp/);
      await set("status = 'READY', ready_at = now()");
      await expect(set("status = 'PREPARING', ready_at = NULL")).rejects.toThrow(/invalid kitchen ticket transition: READY -> PREPARING/);
      await expect(set("status = 'CANCELLED', cancelled_at = now(), ready_at = NULL")).rejects.toThrow(/only records its own timestamp/);
      await set("status = 'CANCELLED', cancelled_at = now()");
      for (const status of ["WAITING", "PREPARING", "READY"]) {
        await expect(set(`status = '${status}', cancelled_at = NULL`), status).rejects.toThrow(/invalid kitchen ticket transition: CANCELLED/);
      }
    });

    it("printing only increments the copy count; it never decreases", async () => {
      const f = await fixture("Vias");
      const ticket = await ticketWithItem(f);
      await owner.$executeRaw`UPDATE kitchen_tickets SET print_count = print_count + 1, last_printed_at = now() WHERE id = ${ticket}::uuid`;
      await expect(owner.$executeRaw`UPDATE kitchen_tickets SET print_count = 1, last_printed_at = NULL WHERE id = ${ticket}::uuid`).rejects.toThrow(/kitchen_tickets_print_check/);
      await expect(owner.$executeRaw`UPDATE kitchen_tickets SET print_count = 0, last_printed_at = NULL WHERE id = ${ticket}::uuid`).rejects.toThrow(/never decreases/);
      await owner.$executeRaw`UPDATE kitchen_tickets SET print_count = print_count + 1, last_printed_at = now() WHERE id = ${ticket}::uuid`;
      expect((await owner.kitchenTicket.findUniqueOrThrow({ where: { id: ticket } })).printCount).toBe(2);
    });
  });

  describe("ticket items", () => {
    it("link the ticket to an item of the SAME order and tenant; each order item in one ticket only", async () => {
      const f = await fixture("Itens comanda");
      const ticket = await ticketWithItem(f);
      await expect(insertItem(owner, f, ticket)).rejects.toThrow(/kitchen_ticket_items_tenant_id_order_id_order_item_id_key|Unique/);
      // Item of another order (same tenant): the FK carries order_id, so it is rejected either way.
      await expect(insertItem(owner, f, ticket, { itemId: f.other.itemId })).rejects.toThrow(/kitchen_ticket_items_tenant_id_order_id_order_item_id_fkey/);
      await expect(insertItem(owner, f, ticket, { orderId: f.other.id, itemId: f.other.itemId })).rejects.toThrow(/kitchen_ticket_items_tenant_id_order_id_ticket_id_fkey/);
    });

    it("are append-only and only enter a new (WAITING, never printed) ticket", async () => {
      const f = await fixture("Itens append-only");
      const ticket = await ticketWithItem(f);
      await expect(owner.$executeRaw`UPDATE kitchen_ticket_items SET created_at = now() WHERE ticket_id = ${ticket}::uuid`).rejects.toThrow(/kitchen ticket items never change/);
      await expect(owner.$executeRaw`DELETE FROM kitchen_ticket_items WHERE ticket_id = ${ticket}::uuid`).rejects.toThrow(/kitchen ticket items never change/);
      const printed = randomUUID();
      await insertTicket(owner, f, { id: printed, orderId: f.other.id });
      await owner.$executeRaw`UPDATE kitchen_tickets SET print_count = 1, last_printed_at = now() WHERE id = ${printed}::uuid`;
      await expect(insertItem(owner, f, printed, { orderId: f.other.id, itemId: f.other.itemId })).rejects.toThrow(/only added to a new ticket/);
    });
  });

  describe("runtime privileges and catalog", () => {
    it("erp_app cannot delete tickets nor change/delete ticket items, even of its own tenant", async () => {
      const f = await fixture("Privilégios cozinha");
      const ticket = await ticketWithItem(f);
      await expect(app.$executeRaw`DELETE FROM kitchen_tickets WHERE id = ${ticket}::uuid`).rejects.toThrow(/permission denied/);
      await expect(app.$executeRaw`UPDATE kitchen_ticket_items SET created_at = now() WHERE ticket_id = ${ticket}::uuid`).rejects.toThrow(/permission denied/);
      await expect(app.$executeRaw`DELETE FROM kitchen_ticket_items WHERE ticket_id = ${ticket}::uuid`).rejects.toThrow(/permission denied/);
      await expect(app.$executeRaw`DELETE FROM kitchen_sectors WHERE id = ${f.bar}::uuid`).rejects.toThrow(/permission denied/);
      await expect(app.$executeRaw`DELETE FROM branch_kitchen_sectors WHERE tenant_id = ${f.tenantId}::uuid`).rejects.toThrow(/permission denied/);
      await expect(app.$executeRawUnsafe(`TRUNCATE "kitchen_tickets"`)).rejects.toThrow(/permission denied/);
    });

    it("pins the kitchen guards in the sale immutability inventory", async () => {
      const kitchen = Object.entries(SALE_IMMUTABILITY_TRIGGERS).filter(([, t]) => t.table.startsWith("kitchen_")).map(([name]) => name).sort();
      expect(kitchen).toEqual(["kitchen_ticket_items_guard", "kitchen_ticket_items_no_truncate", "kitchen_tickets_guard", "kitchen_tickets_no_truncate"]);
      expect(await saleImmutabilityViolations(owner)).toEqual([]);
    });
  });
});
