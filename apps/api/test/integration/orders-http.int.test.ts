import { randomUUID } from "node:crypto";
import type { OrderDto, OrderSummaryDto, Page, ProductDto } from "@erp/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { BranchStatus, CompanyStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { CLOCK, type Clock } from "../../src/clock/clock.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

type Role = "OWNER" | "MANAGER" | "ATTENDANT" | "KITCHEN";
const NOT_FOUND = { status: 404, body: { error: "not_found" } };
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const INVALID_TRANSITION = { status: 409, body: { error: "order_invalid_transition" } };

/** Controlled clock: system time unless a fixed instant is set (reset after every test). */
class TestClock implements Clock {
  fixed: Date | null = null;
  now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }
}

interface Actor {
  readonly userId: string;
  readonly name: string;
  readonly token: string;
}

// M5 over real HTTP: AppModule (guards, filters), runtime identity erp_app, default roles, injected clock.
describe("M5 orders APIs over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  const clock = new TestClock();

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config, [], [], [{ provide: CLOCK, useValue: clock }]);
    await ensurePermissionCatalog(owner);
  });

  afterEach(() => {
    clock.fixed = null;
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  async function login(org: Org, role: Role | null, branches: string[]): Promise<Actor> {
    const user = await seedUser(owner, org.tenantId);
    for (const branchId of branches) await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId } });
    if (role) {
      const { id: roleId } = await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code: role } } });
      await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId } });
    }
    const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123" });
    return { userId: user.id, name: `User ${user.employeeNumber}`, token: tokens.accessToken };
  }

  function client(actor: Actor) {
    const token = actor.token;
    return {
      get: (path: string) => http.request(path, { token }),
      post: (path: string, body?: unknown) => http.request(path, { method: "POST", token, ...(body !== undefined ? { body } : {}) }),
      put: (path: string, body: unknown) => http.request(path, { method: "PUT", token, body }),
      patch: (path: string, body: unknown) => http.request(path, { method: "PATCH", token, body }),
    };
  }
  type Client = ReturnType<typeof client>;

  /** M6: confirming needs an OPEN cash session of the confirmer in the branch (opened once; 409 = already open/inactive). */
  async function ensureCash(as: Client, base: string): Promise<void> {
    const res = await as.post(base.replace(/\/orders$/, "/cash-sessions"), { openingAmount: "0.00" });
    if (res.status !== 201 && res.status !== 409) throw new Error(`cannot open the cash session: ${JSON.stringify(res)}`);
  }

  /** M6: the order is paid before confirming — pays `total` (default: the order's current total) by PIX. */
  async function payAndConfirm(as: Client, base: string, orderId: string, total?: string) {
    await ensureCash(as, base);
    const amount = total ?? (((await as.get(`${base}/${orderId}`)).body as Partial<OrderDto>).total ?? "1.00");
    return as.post(`${base}/${orderId}/confirm`, { payments: amount === "0.00" ? [] : [{ method: "PIX", amount }] });
  }

  /** A state action; `confirm` carries the payment body. */
  const act = (as: Client, base: string, orderId: string, action: string) =>
    action === "confirm" ? payAndConfirm(as, base, orderId) : as.post(`${base}/${orderId}/${action}`);

  /**
   * Isolated shop: tenant with MAIN and OTHER branches, actors (owner/manager reach both; the rest only MAIN) and a
   * catalog created through the M4 API: burger (required size + optional extras), candy, drink, and a combo linking the drink.
   */
  async function shop(name: string) {
    const org = await seedOrg(owner, name);
    await h.tenants.run({ tenantId: org.tenantId }, () => new TenantProvisioningService(prisma, h.scope).provisionDefaultRoles());
    const actors = {
      owner: await login(org, "OWNER", [org.branchId, org.otherBranchId]),
      manager: await login(org, "MANAGER", [org.branchId, org.otherBranchId]),
      attendant: await login(org, "ATTENDANT", [org.branchId]),
      attendant2: await login(org, "ATTENDANT", [org.branchId]),
      kitchen: await login(org, "KITCHEN", [org.branchId]),
      nobody: await login(org, null, [org.branchId]),
    };
    const api = client(actors.owner);
    const product = async (body: Record<string, unknown>) => {
      const res = await api.post("/products", body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as ProductDto;
    };
    const drink = await product({ name: "Refri", code: "REFRI", basePrice: "6.00" });
    const burger = await product({
      name: "X-Burger",
      code: "XB",
      basePrice: "25.00",
      optionGroups: [
        { name: "Tamanho", minChoices: 1, maxChoices: 1, options: [{ name: "P" }, { name: "G", priceDelta: "4.00" }] },
        { name: "Extras", minChoices: 0, maxChoices: 2, options: [{ name: "Bacon", priceDelta: "3.50" }, { name: "Ovo", priceDelta: "2.00" }, { name: "Queijo", priceDelta: "1.50" }] },
      ],
    });
    const candy = await product({ name: "Bala", basePrice: "0.10" });
    const combo = await product({
      name: "Combo",
      basePrice: "30.00",
      optionGroups: [{ name: "Bebida", minChoices: 1, maxChoices: 1, options: [{ name: "Refri", linkedProductId: drink.id }] }],
    });
    const opt = (p: ProductDto, group: number, option: number) => p.optionGroups[group]!.options[option]!.id;
    return { org, actors, api, drink, burger, candy, combo, opt, main: `/branches/${org.branchId}/orders`, other: `/branches/${org.otherBranchId}/orders` };
  }
  type Shop = Awaited<ReturnType<typeof shop>>;

  const burgerG = (s: Shop, quantity = 1) => ({ productId: s.burger.id, quantity, optionIds: [s.opt(s.burger, 0, 1)] });

  async function draft(s: Shop, items: unknown[] = [burgerG(s)], as: Client = client(s.actors.attendant), base = s.main): Promise<OrderDto> {
    const res = await as.post(base, { items });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as OrderDto;
  }

  async function confirmed(s: Shop, as: Client = client(s.actors.attendant), base = s.main): Promise<OrderDto> {
    const order = await draft(s, [burgerG(s)], as, base);
    const res = await payAndConfirm(as, base, order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as OrderDto;
  }

  describe("authentication and authorization", () => {
    it("requires a token on every route", async () => {
      const base = `/branches/${randomUUID()}/orders`;
      const id = randomUUID();
      for (const [method, path] of [["POST", base], ["GET", base], ["GET", `${base}/${id}`], ["PUT", `${base}/${id}/items`], ...["confirm", "start", "ready", "deliver", "cancel"].map((a) => ["POST", `${base}/${id}/${a}`])] as [string, string][]) {
        expect(await http.request(path, { method }), `${method} ${path}`).toEqual({ status: 401, body: { error: "unauthenticated" } });
      }
    });

    it("OWNER, MANAGER and ATTENDANT create, edit, confirm and move orders; KITCHEN only reads; no role = 403", async () => {
      const s = await shop("Matriz roles");
      for (const role of ["owner", "manager", "attendant"] as const) {
        const as = client(s.actors[role]);
        const order = await draft(s, [burgerG(s)], as);
        expect((await as.put(`${s.main}/${order.id}/items`, { items: [burgerG(s, 2)] })).status).toBe(200);
        for (const action of ["confirm", "start", "ready", "deliver"]) expect((await act(as, s.main, order.id, action)).status, `${role} ${action}`).toBe(200);
        expect((await as.get(`${s.main}/${order.id}`)).status).toBe(200);
        expect((await as.get(s.main)).status).toBe(200);
      }
      const order = await draft(s);
      const kitchen = client(s.actors.kitchen);
      expect((await kitchen.get(s.main)).status).toBe(200);
      expect((await kitchen.get(`${s.main}/${order.id}`)).status).toBe(200);
      expect(await kitchen.post(s.main, {})).toEqual(FORBIDDEN);
      expect(await kitchen.put(`${s.main}/${order.id}/items`, { items: [] })).toEqual(FORBIDDEN);
      for (const action of ["confirm", "start", "ready", "deliver", "cancel"]) expect(await kitchen.post(`${s.main}/${order.id}/${action}`, {}), action).toEqual(FORBIDDEN);
      for (const [method, path] of [["GET", s.main], ["GET", `${s.main}/${order.id}`], ["POST", s.main], ["POST", `${s.main}/${order.id}/cancel`]] as const) {
        expect(await http.request(path, { method, token: s.actors.nobody.token, ...(method === "POST" ? { body: {} } : {}) }), `${method} ${path}`).toEqual(FORBIDDEN);
      }
      expect((await owner.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EDITING");
    });

    it("every route requires access to THAT branch (other branch, other tenant, missing, malformed) — even for OWNER", async () => {
      const s = await shop("Escopo filial");
      const foreign = await shop("Outro tenant");
      const order = await draft(s);
      for (const branch of [s.org.otherBranchId, foreign.org.branchId, randomUUID(), "not-a-uuid"]) {
        const base = `/branches/${branch}/orders`;
        for (const [method, path] of [["GET", base], ["POST", base], ["GET", `${base}/${order.id}`], ["PUT", `${base}/${order.id}/items`], ["POST", `${base}/${order.id}/confirm`], ["POST", `${base}/${order.id}/cancel`]] as const) {
          expect(await http.request(path, { method, token: s.actors.attendant.token, ...(method !== "GET" ? { body: method === "PUT" ? { items: [] } : {} } : {}) }), `${method} ${path}`).toEqual(FORBIDDEN);
        }
      }
      expect(await client(s.actors.owner).get(`/branches/${foreign.org.branchId}/orders`)).toEqual(FORBIDDEN);
    });
  });

  describe("drafts (POST orders, PUT items)", () => {
    it("creates an empty draft with an optional body; author with name; no number yet", async () => {
      const s = await shop("Rascunho");
      const res = await client(s.actors.attendant).post(s.main);
      expect(res.status).toBe(201);
      const order = res.body as OrderDto;
      expect(order).toMatchObject({
        branchId: s.org.branchId,
        status: "EDITING",
        number: null,
        businessDate: null,
        total: "0.00",
        itemCount: 0,
        items: [],
        confirmedAt: null,
        cancelledBy: null,
        createdBy: { userId: s.actors.attendant.userId, name: s.actors.attendant.name },
      });
      expect(Object.keys(order).sort()).toEqual(
        ["branchId", "businessDate", "cancelReason", "cancelledAt", "cancelledBy", "changeGiven", "confirmedAt", "createdAt", "createdBy", "deliveredAt", "id", "itemCount", "items", "kitchenTickets", "number", "payments", "preparingAt", "readyAt", "refunds", "status", "total"],
      );
      expect(order).toMatchObject({ payments: [], refunds: [], changeGiven: "0.00" });
      expect((await client(s.actors.attendant).post(s.main, {})).status).toBe(201);
    });

    it("prices items from the branch menu (override + priceDelta) and stores a snapshot", async () => {
      const s = await shop("Preço");
      await s.api.put(`/branches/${s.org.branchId}/product-settings/${s.burger.id}`, { available: true, price: "27.00" });
      const order = await draft(s, [
        { productId: s.burger.id, quantity: 2, optionIds: [s.opt(s.burger, 1, 0), s.opt(s.burger, 0, 1)], note: "  sem cebola " },
        { productId: s.candy.id, quantity: 3 },
        { productId: s.combo.id, quantity: 1, optionIds: [s.opt(s.combo, 0, 0)] },
      ]);
      expect(order.total).toBe("99.30"); // (27 + 4 + 3.5) × 2 + 0.10 × 3 + 30
      expect(order.items).toEqual([
        {
          id: expect.any(String),
          productId: s.burger.id,
          productName: "X-Burger",
          productCode: "XB",
          quantity: 2,
          unitPrice: "34.50",
          lineTotal: "69.00",
          note: "sem cebola",
          options: [
            { optionId: s.opt(s.burger, 0, 1), groupName: "Tamanho", name: "G", priceDelta: "4.00", linkedProductId: null },
            { optionId: s.opt(s.burger, 1, 0), groupName: "Extras", name: "Bacon", priceDelta: "3.50", linkedProductId: null },
          ],
        },
        { id: expect.any(String), productId: s.candy.id, productName: "Bala", productCode: null, quantity: 3, unitPrice: "0.10", lineTotal: "0.30", note: null, options: [] },
        {
          id: expect.any(String),
          productId: s.combo.id,
          productName: "Combo",
          productCode: null,
          quantity: 1,
          unitPrice: "30.00",
          lineTotal: "30.00",
          note: null,
          options: [{ optionId: s.opt(s.combo, 0, 0), groupName: "Bebida", name: "Refri", priceDelta: "0.00", linkedProductId: s.drink.id }],
        },
      ]);
      expect(order.itemCount).toBe(3);
    });

    it("rejects mass assignment and malformed items with paths", async () => {
      const s = await shop("Validação");
      const as = client(s.actors.attendant);
      expect(await as.post(s.main, { status: "CONFIRMED", tenantId: s.org.tenantId, total: "1.00", items: [{ productId: s.candy.id, quantity: 1, unitPrice: "0.01" }] })).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "status", issue: "unknown_field" },
            { field: "tenantId", issue: "unknown_field" },
            { field: "total", issue: "unknown_field" },
            { field: "items[0].unitPrice", issue: "unknown_field" },
          ],
        },
      });
      expect((await as.post(s.main, { items: [{ productId: s.candy.id, quantity: 0 }, { productId: "x", quantity: 1, note: "n".repeat(141) }] })).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "items[0].quantity", issue: "invalid_value" },
          { field: "items[1].productId", issue: "invalid_format" },
          { field: "items[1].note", issue: "too_long" },
        ],
      });
      expect(await owner.order.count({ where: { tenantId: s.org.tenantId } })).toBe(0);
    });

    it("rejects products not sellable in the branch and invalid choices, with the item path", async () => {
      const s = await shop("Itens inválidos");
      const foreign = await shop("Itens de outro tenant");
      const off = (await s.api.post("/products", { name: "Fora", basePrice: "1" })).body as ProductDto;
      await s.api.put(`/branches/${s.org.branchId}/product-settings/${off.id}`, { available: false, price: null });
      const inactive = (await s.api.post("/products", { name: "Inativo", basePrice: "1" })).body as ProductDto;
      await s.api.post(`/products/${inactive.id}/deactivate`);
      await s.api.post(`/products/${s.drink.id}/deactivate`); // the combo's only drink becomes unsellable
      const res = await client(s.actors.attendant).post(s.main, {
        items: [
          { productId: off.id, quantity: 1 },
          { productId: inactive.id, quantity: 1 },
          { productId: foreign.candy.id, quantity: 1 },
          { productId: randomUUID(), quantity: 1 },
          { productId: s.burger.id, quantity: 1 }, // required size missing
          { productId: s.burger.id, quantity: 1, optionIds: [s.opt(s.burger, 0, 0), s.opt(s.burger, 0, 1)] }, // two sizes
          { productId: s.burger.id, quantity: 1, optionIds: [s.opt(s.burger, 0, 0), s.opt(s.burger, 0, 0)] }, // repeated
          { productId: s.burger.id, quantity: 1, optionIds: [s.opt(s.burger, 0, 0), s.opt(s.combo, 0, 0)] }, // option of another product
          { productId: s.burger.id, quantity: 1, optionIds: [s.opt(s.burger, 0, 0), s.opt(s.burger, 1, 0), s.opt(s.burger, 1, 1), s.opt(s.burger, 1, 2)] }, // 3 extras, max 2
          { productId: s.combo.id, quantity: 1, optionIds: [s.opt(s.combo, 0, 0)] }, // combo without sellable drink
          { productId: s.candy.id, quantity: 1 },
        ],
      });
      expect(res).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "items[0].productId", issue: "unavailable" },
            { field: "items[1].productId", issue: "unavailable" },
            { field: "items[2].productId", issue: "unavailable" },
            { field: "items[3].productId", issue: "unavailable" },
            { field: "items[4].optionIds", issue: "invalid_choices" },
            { field: "items[5].optionIds", issue: "invalid_choices" },
            { field: "items[6].optionIds", issue: "invalid_choices" },
            { field: "items[7].optionIds", issue: "invalid_choices" },
            { field: "items[8].optionIds", issue: "invalid_choices" },
            { field: "items[9].productId", issue: "unavailable" },
          ],
        },
      });
    });

    it("refuses a total above numeric(12,2) with 400 on items", async () => {
      const s = await shop("Total máximo");
      const expensive = (await s.api.post("/products", { name: "Caro", basePrice: "9999999999.99" })).body as ProductDto;
      expect(await client(s.actors.attendant).post(s.main, { items: [{ productId: expensive.id, quantity: 2 }] })).toEqual({
        status: 400,
        body: { error: "validation_failed", details: [{ field: "items", issue: "invalid_value" }] },
      });
      expect((await draft(s, [{ productId: expensive.id, quantity: 1 }])).total).toBe("9999999999.99");
    });

    it("replaces all items while EDITING (empty list allowed); after confirmation 409 order_not_editable", async () => {
      const s = await shop("Substituir");
      const as = client(s.actors.attendant);
      const order = await draft(s);
      const replaced = await as.put(`${s.main}/${order.id}/items`, { items: [{ productId: s.candy.id, quantity: 5 }] });
      expect(replaced).toMatchObject({ status: 200, body: { total: "0.50", itemCount: 1 } });
      expect((replaced.body as OrderDto).items.map((i) => i.productName)).toEqual(["Bala"]);
      expect((await as.put(`${s.main}/${order.id}/items`, { items: [] })).body).toMatchObject({ total: "0.00", items: [] });
      expect(await payAndConfirm(as, s.main, order.id)).toEqual({ status: 409, body: { error: "order_empty" } });
      expect((await as.put(`${s.main}/${order.id}/items`, {})).body).toEqual({ error: "validation_failed", details: [{ field: "items", issue: "required" }] });
      const done = await confirmed(s);
      expect(await as.put(`${s.main}/${done.id}/items`, { items: [] })).toEqual({ status: 409, body: { error: "order_not_editable" } });
    });

    it("an order of another branch (same tenant) or another tenant is 404; malformed id is 404", async () => {
      const s = await shop("404 pedidos");
      const foreign = await shop("404 outro tenant");
      const otherBranchOrder = await draft(s, [burgerG(s)], client(s.actors.manager), s.other);
      const foreignOrder = await draft(foreign);
      const manager = client(s.actors.manager); // has access to both branches
      for (const id of [otherBranchOrder.id, foreignOrder.id, randomUUID(), "not-a-uuid"]) {
        expect(await manager.get(`${s.main}/${id}`), id).toEqual(NOT_FOUND);
        expect(await manager.put(`${s.main}/${id}/items`, { items: [] })).toEqual(NOT_FOUND);
        for (const action of ["confirm", "start", "ready", "deliver"]) expect(await act(manager, s.main, id, action)).toEqual(NOT_FOUND);
        expect(await manager.post(`${s.main}/${id}/cancel`, { reason: "teste" })).toEqual(NOT_FOUND);
      }
      expect(((await manager.get(s.main)).body as Page<OrderSummaryDto>).items.map((o) => o.id)).not.toContain(otherBranchOrder.id);
      expect((await owner.order.findUniqueOrThrow({ where: { id: foreignOrder.id } })).status).toBe("EDITING");
    });
  });

  describe("inactive branch or company", () => {
    it("cannot open or confirm an order (409), while menu and settings stay readable", async () => {
      const s = await shop("Inativa");
      const as = client(s.actors.attendant);
      const pending = await draft(s);
      await owner.branch.update({ where: { id: s.org.branchId }, data: { status: BranchStatus.INACTIVE } });
      expect(await as.post(s.main, {})).toEqual({ status: 409, body: { error: "branch_inactive" } });
      expect(await payAndConfirm(as, s.main, pending.id)).toEqual({ status: 409, body: { error: "branch_inactive" } });
      expect((await as.get(`/branches/${s.org.branchId}/menu`)).status).toBe(200);
      await owner.branch.update({ where: { id: s.org.branchId }, data: { status: BranchStatus.ACTIVE } });
      await owner.company.update({ where: { id: s.org.companyId }, data: { status: CompanyStatus.INACTIVE } });
      expect(await as.post(s.main, {})).toEqual({ status: 409, body: { error: "company_inactive" } });
      expect(await payAndConfirm(as, s.main, pending.id)).toEqual({ status: 409, body: { error: "company_inactive" } });
      expect((await owner.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("EDITING");
    });
  });

  describe("confirmation", () => {
    it("assigns the number, the business day and recalculates from the current menu", async () => {
      const s = await shop("Confirmar");
      const as = client(s.actors.attendant);
      const order = await draft(s, [burgerG(s, 2)]);
      expect(order.total).toBe("58.00");
      await s.api.put(`/branches/${s.org.branchId}/product-settings/${s.burger.id}`, { available: true, price: "26.00" });
      clock.fixed = new Date("2026-11-09T15:00:00.000Z");
      const res = await payAndConfirm(as, s.main, order.id, "60.00");
      expect(res).toMatchObject({ status: 200, body: { status: "CONFIRMED", number: 1, businessDate: "2026-11-09", total: "60.00", confirmedAt: "2026-11-09T15:00:00.000Z" } });
      expect((res.body as OrderDto).items[0]).toMatchObject({ unitPrice: "30.00", lineTotal: "60.00" });
      expect(await payAndConfirm(as, s.main, order.id)).toEqual(INVALID_TRANSITION);
    });

    it("fails with 409 order_item_unavailable + details when an item stopped being sellable; the draft is kept", async () => {
      const s = await shop("Indisponível");
      const as = client(s.actors.attendant);
      const order = await draft(s, [{ productId: s.candy.id, quantity: 1 }, burgerG(s), { productId: s.combo.id, quantity: 1, optionIds: [s.opt(s.combo, 0, 0)] }]);
      await s.api.post(`/products/${s.candy.id}/deactivate`);
      // Replacing the burger groups deletes the chosen option (M4 block replacement).
      await s.api.put(`/products/${s.burger.id}/option-groups`, { optionGroups: [{ name: "Tamanho", minChoices: 1, maxChoices: 1, options: [{ name: "Único" }] }] });
      await s.api.put(`/branches/${s.org.branchId}/product-settings/${s.drink.id}`, { available: false, price: null });
      expect(await payAndConfirm(as, s.main, order.id)).toEqual({
        status: 409,
        body: {
          error: "order_item_unavailable",
          details: [
            { field: "items[0].productId", issue: "unavailable" },
            { field: "items[1].optionIds", issue: "invalid_choices" },
            { field: "items[2].productId", issue: "unavailable" },
          ],
        },
      });
      const after = await owner.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
      expect(after).toMatchObject({ status: "EDITING", number: null });
      expect(after.items).toHaveLength(3);
    });

    it("keeps the snapshot: changing or deactivating the product afterwards does not change the order", async () => {
      const s = await shop("Snapshot");
      const order = await confirmed(s);
      await s.api.patch(`/products/${s.burger.id}`, { name: "X-Burger Novo", basePrice: "99.00", code: "XN" });
      await s.api.put(`/products/${s.burger.id}/option-groups`, { optionGroups: [] });
      await s.api.post(`/products/${s.burger.id}/deactivate`);
      expect((await client(s.actors.attendant).get(`${s.main}/${order.id}`)).body).toEqual(order);
    });
  });

  describe("state transitions", () => {
    it("runs the full flow to DELIVERED with state timestamps from the clock", async () => {
      const s = await shop("Fluxo");
      const as = client(s.actors.attendant);
      const order = await confirmed(s);
      const steps = [
        ["start", "PREPARING", "preparingAt", "2026-11-09T15:01:00.000Z"],
        ["ready", "READY", "readyAt", "2026-11-09T15:05:00.000Z"],
        ["deliver", "DELIVERED", "deliveredAt", "2026-11-09T15:06:00.000Z"],
      ] as const;
      for (const [action, status, field, at] of steps) {
        clock.fixed = new Date(at);
        const res = await as.post(`${s.main}/${order.id}/${action}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status, [field]: at, number: order.number, total: order.total });
      }
    });

    it("rejects transitions out of order and repeated transitions with 409", async () => {
      const s = await shop("Transições inválidas");
      const as = client(s.actors.attendant);
      const editing = await draft(s);
      for (const action of ["start", "ready", "deliver"]) expect(await as.post(`${s.main}/${editing.id}/${action}`), action).toEqual(INVALID_TRANSITION);
      const order = await confirmed(s);
      expect(await as.post(`${s.main}/${order.id}/ready`)).toEqual(INVALID_TRANSITION);
      expect(await as.post(`${s.main}/${order.id}/deliver`)).toEqual(INVALID_TRANSITION);
      expect((await as.post(`${s.main}/${order.id}/start`)).status).toBe(200);
      expect(await as.post(`${s.main}/${order.id}/start`)).toEqual(INVALID_TRANSITION);
      expect(await payAndConfirm(as, s.main, order.id)).toEqual(INVALID_TRANSITION);
      await as.post(`${s.main}/${order.id}/ready`);
      await as.post(`${s.main}/${order.id}/deliver`);
      for (const action of ["confirm", "start", "ready", "deliver"]) expect(await act(as, s.main, order.id, action)).toEqual(INVALID_TRANSITION);
      // M6: DELIVERED is cancellable with order.cancel + reason (full refund of the PIX payment, no cash session needed).
      expect(await client(s.actors.manager).post(`${s.main}/${order.id}/cancel`, { reason: "estorno" })).toMatchObject({
        status: 200,
        body: { status: "CANCELLED", refunds: [{ method: "PIX", amount: order.total, cashSessionId: null }] },
      });
      expect(await client(s.actors.manager).post(`${s.main}/${order.id}/cancel`, { reason: "estorno" })).toEqual(INVALID_TRANSITION);
    });
  });

  describe("cancellation", () => {
    it("EDITING: the author (order.create) or order.cancel may discard it, reason optional; another attendant gets 403", async () => {
      const s = await shop("Cancelar rascunho");
      const mine = await draft(s);
      expect(await client(s.actors.attendant2).post(`${s.main}/${mine.id}/cancel`)).toEqual(FORBIDDEN);
      expect(await client(s.actors.kitchen).post(`${s.main}/${mine.id}/cancel`)).toEqual(FORBIDDEN);
      clock.fixed = new Date("2026-11-09T16:00:00.000Z");
      const res = await client(s.actors.attendant).post(`${s.main}/${mine.id}/cancel`);
      expect(res).toMatchObject({
        status: 200,
        body: { status: "CANCELLED", number: null, cancelledAt: "2026-11-09T16:00:00.000Z", cancelReason: null, cancelledBy: { userId: s.actors.attendant.userId, name: s.actors.attendant.name } },
      });
      const other = await draft(s);
      expect(await client(s.actors.manager).post(`${s.main}/${other.id}/cancel`, { reason: "duplicado" })).toMatchObject({ status: 200, body: { cancelReason: "duplicado" } });
      expect(await client(s.actors.attendant).post(`${s.main}/${mine.id}/cancel`)).toEqual(INVALID_TRANSITION);
    });

    it("confirmed: only order.cancel in the branch, with a 3–200 reason; the author attendant gets 403", async () => {
      const s = await shop("Cancelar confirmado");
      const order = await confirmed(s);
      const manager = client(s.actors.manager);
      expect(await client(s.actors.attendant).post(`${s.main}/${order.id}/cancel`, { reason: "cliente desistiu" })).toEqual(FORBIDDEN);
      expect(await manager.post(`${s.main}/${order.id}/cancel`)).toEqual({ status: 400, body: { error: "validation_failed", details: [{ field: "reason", issue: "required" }] } });
      expect((await manager.post(`${s.main}/${order.id}/cancel`, { reason: " ab " })).body).toEqual({ error: "validation_failed", details: [{ field: "reason", issue: "too_short" }] });
      expect((await manager.post(`${s.main}/${order.id}/cancel`, { reason: "ok!", extra: 1 })).body).toEqual({ error: "validation_failed", details: [{ field: "extra", issue: "unknown_field" }] });
      const res = await manager.post(`${s.main}/${order.id}/cancel`, { reason: "  cliente desistiu  " });
      expect(res).toMatchObject({ status: 200, body: { status: "CANCELLED", number: order.number, cancelReason: "cliente desistiu", cancelledBy: { userId: s.actors.manager.userId } } });
      for (const step of [["start"], ["start", "ready"]]) {
        const next = await confirmed(s);
        for (const action of step) await client(s.actors.attendant).post(`${s.main}/${next.id}/${action}`);
        expect((await client(s.actors.owner).post(`${s.main}/${next.id}/cancel`, { reason: "cozinha sem pão" })).status, step.join(">")).toBe(200);
      }
    });
  });

  describe("numbering", () => {
    it("numbers per branch, independently, and a cancelled draft consumes nothing", async () => {
      const s = await shop("Numeração");
      const manager = client(s.actors.manager);
      const numbers: (number | null)[] = [];
      numbers.push((await confirmed(s, manager)).number);
      const discarded = await draft(s, [burgerG(s)], manager);
      await manager.post(`${s.main}/${discarded.id}/cancel`);
      numbers.push((await confirmed(s, manager)).number);
      numbers.push((await confirmed(s, manager, s.other)).number);
      numbers.push((await confirmed(s, manager)).number);
      numbers.push((await confirmed(s, manager, s.other)).number);
      expect(numbers).toEqual([1, 2, 1, 3, 2]);
    });

    it("restarts at the day turn in the BRANCH time zone (São Paulo and Manaus), using the injected clock", async () => {
      const s = await shop("Virada do dia");
      await owner.branch.update({ where: { id: s.org.otherBranchId }, data: { timezone: "America/Manaus" } });
      const manager = client(s.actors.manager);
      const at = async (instant: string, base: string) => {
        clock.fixed = new Date(instant);
        const o = await confirmed(s, manager, base);
        return [o.number, o.businessDate];
      };
      expect(await at("2026-11-09T02:59:00.000Z", s.main)).toEqual([1, "2026-11-08"]);
      expect(await at("2026-11-09T02:59:59.000Z", s.main)).toEqual([2, "2026-11-08"]);
      expect(await at("2026-11-09T03:00:00.000Z", s.main)).toEqual([1, "2026-11-09"]);
      expect(await at("2026-11-09T03:30:00.000Z", s.other)).toEqual([1, "2026-11-08"]); // still the 8th in Manaus (UTC-4)
      expect(await at("2026-11-09T04:00:00.000Z", s.other)).toEqual([1, "2026-11-09"]);
      expect(await at("2026-11-09T04:00:01.000Z", s.main)).toEqual([2, "2026-11-09"]);
    });
  });

  describe("listing", () => {
    it("lists the branch's orders newest first, filtered by status list and business day, paginated", async () => {
      const s = await shop("Listagem");
      const as = client(s.actors.attendant);
      clock.fixed = new Date("2026-11-08T15:00:00.000Z");
      const yesterday = await confirmed(s);
      clock.fixed = new Date("2026-11-09T15:00:00.000Z");
      const today = await confirmed(s);
      await as.post(`${s.main}/${today.id}/start`);
      const editing = await draft(s, [burgerG(s), { productId: s.candy.id, quantity: 1 }]);
      await confirmed(s, client(s.actors.manager), s.other);

      const page = (await as.get(`${s.main}?pageSize=2`)).body as Page<OrderSummaryDto>;
      expect(page).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
      expect(page.items.map((o) => o.id)).toEqual([editing.id, today.id]);
      expect(page.items[0]).toMatchObject({ itemCount: 2, number: null, status: "EDITING" });
      expect(Object.keys(page.items[0]!).sort()).toEqual(["branchId", "businessDate", "confirmedAt", "createdAt", "id", "itemCount", "number", "status", "total"]);
      const ids = async (q: string) => ((await as.get(`${s.main}?${q}`)).body as Page<OrderSummaryDto>).items.map((o) => o.id);
      expect(await ids("page=2&pageSize=2")).toEqual([yesterday.id]);
      expect(await ids("status=CONFIRMED,PREPARING")).toEqual([today.id, yesterday.id]);
      expect(await ids("status=PREPARING")).toEqual([today.id]);
      expect(await ids("businessDate=2026-11-08")).toEqual([yesterday.id]);
      expect(await ids("businessDate=2026-11-09&status=EDITING")).toEqual([]);
      expect((await as.get(`${s.main}?status=DONE&businessDate=2026-02-30&foo=1`)).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "foo", issue: "unknown_field" },
          { field: "status", issue: "invalid_value" },
          { field: "businessDate", issue: "invalid_value" },
        ],
      });
    });
  });

  describe("money", () => {
    it("never loses precision: 0.10 × 3 = 0.30 and many items add up exactly", async () => {
      const s = await shop("Dinheiro");
      const order = await draft(s, Array.from({ length: 100 }, () => ({ productId: s.candy.id, quantity: 3 })));
      expect(order.items[0]).toMatchObject({ unitPrice: "0.10", lineTotal: "0.30" });
      expect(order.total).toBe("30.00");
      const confirmedOrder = (await payAndConfirm(client(s.actors.attendant), s.main, order.id)).body as OrderDto;
      expect(confirmedOrder.total).toBe("30.00");
      const [row] = await owner.$queryRaw<{ sum: string }[]>`SELECT sum(line_total)::text AS sum FROM order_items WHERE order_id = ${order.id}::uuid`;
      expect(row?.sum).toBe("30.00");
    });
  });

  describe("concurrency", () => {
    it("20 parallel confirmations in one branch get numbers 1..20, no repeats, no gaps", async () => {
      const s = await shop("Corrida números");
      const as = client(s.actors.attendant);
      const drafts = await Promise.all(Array.from({ length: 20 }, () => draft(s, [{ productId: s.candy.id, quantity: 1 }])));
      await ensureCash(as, s.main);
      const results = await Promise.all(drafts.map((d) => as.post(`${s.main}/${d.id}/confirm`, { payments: [{ method: "PIX", amount: d.total }] })));
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
      expect(results.map((r) => (r.body as OrderDto).number).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it("confirming the same order twice in parallel: one 200, one 409", async () => {
      const s = await shop("Corrida mesmo pedido");
      const as = client(s.actors.attendant);
      await ensureCash(as, s.main);
      for (let round = 0; round < 5; round++) {
        const order = await draft(s);
        const pay = { payments: [{ method: "PIX", amount: order.total }] };
        const results = await Promise.all([as.post(`${s.main}/${order.id}/confirm`, pay), as.post(`${s.main}/${order.id}/confirm`, pay)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      }
      expect((await owner.branchOrderCounter.findMany({ where: { branchId: s.org.branchId } })).map((c) => c.lastNumber)).toEqual([5]);
    });

    it("a confirmation waits for a pending branch/company deactivation and then fails — never confirms after it", async () => {
      const s = await shop("Corrida desativação");
      const as = client(s.actors.attendant);
      await ensureCash(as, s.main);
      for (const [target, code] of [["branch", "branch_inactive"], ["company", "company_inactive"]] as const) {
        const order = await draft(s);
        let settled = false;
        let confirmation: Promise<{ status: number; body: unknown }> | undefined;
        await owner.$transaction(
          async (tx) => {
            if (target === "branch") await tx.branch.update({ where: { id: s.org.branchId }, data: { status: BranchStatus.INACTIVE } });
            else await tx.company.update({ where: { id: s.org.companyId }, data: { status: CompanyStatus.INACTIVE } });
            confirmation = as.post(`${s.main}/${order.id}/confirm`, { payments: [{ method: "PIX", amount: order.total }] }).finally(() => (settled = true));
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(settled, `${target}: confirmation must wait for the deactivation`).toBe(false);
          },
          { timeout: 10_000 },
        );
        expect(await confirmation).toEqual({ status: 409, body: { error: code } });
        expect((await owner.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EDITING");
        if (target === "branch") await owner.branch.update({ where: { id: s.org.branchId }, data: { status: BranchStatus.ACTIVE } });
      }
    });

    it("cancel × confirm in parallel always ends in a coherent state", async () => {
      const s = await shop("Corrida cancelar");
      const manager = client(s.actors.manager);
      await ensureCash(manager, s.main);
      for (let round = 0; round < 6; round++) {
        const order = await draft(s, [burgerG(s)], manager);
        const [confirm, cancel] = await Promise.all([manager.post(`${s.main}/${order.id}/confirm`, { payments: [{ method: "PIX", amount: order.total }] }), manager.post(`${s.main}/${order.id}/cancel`, { reason: "desistiu" })]);
        const final = await owner.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
        expect(final.status).toBe("CANCELLED");
        if (confirm.status === 200) {
          // Confirmed first, then cancelled with the reason.
          expect(final.number).not.toBeNull();
          expect(final.cancelReason).toBe("desistiu");
        } else {
          // Cancelled as a draft first: the confirmation found it CANCELLED.
          expect(confirm).toEqual(INVALID_TRANSITION);
          expect(final.number).toBeNull();
        }
      }
    });
  });
});
