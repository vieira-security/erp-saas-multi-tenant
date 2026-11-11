import { randomUUID } from "node:crypto";
import type {
  BranchKitchenSectorDto,
  KitchenSectorDto,
  KitchenTicketDto,
  KitchenTicketPrintDto,
  OrderDto,
  Page,
  ProductDto,
} from "@erp/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { CLOCK, type Clock } from "../../src/clock/clock.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

type Role = "OWNER" | "MANAGER" | "ATTENDANT" | "KITCHEN" | "READER";
const NOT_FOUND = { status: 404, body: { error: "not_found" } };
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const ORDER_TRANSITION = { status: 409, body: { error: "order_invalid_transition" } };
const TICKET_TRANSITION = { status: 409, body: { error: "kitchen_ticket_invalid_transition" } };
const DEFAULT_REQUIRED = { status: 409, body: { error: "kitchen_sector_default_required" } };
const TICKET_KEYS = ["cancelledAt", "createdAt", "businessDate", "id", "items", "lastPrintedAt", "orderId", "orderNumber", "printCount", "readyAt", "sector", "startedAt", "status"].sort();

class TestClock implements Clock {
  fixed: Date | null = null;
  now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }
}

interface Actor {
  readonly userId: string;
  readonly token: string;
}

// M7 over real HTTP: AppModule (guards, filters), runtime identity erp_app, default roles + default sector, injected clock.
describe("M7 kitchen APIs over HTTP (PostgreSQL, as erp_app)", () => {
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

  /** READER = custom role with `order.read` and `product.read` only (no `order.prepare`). */
  async function login(org: Org, role: Role | null, branches: string[]): Promise<Actor> {
    const user = await seedUser(owner, org.tenantId);
    for (const branchId of branches) await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId } });
    if (role) {
      const { id: roleId } = await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code: role } } });
      await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId } });
    }
    const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123" });
    return { userId: user.id, token: tokens.accessToken };
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

  async function ok<T>(promise: Promise<{ status: number; body: unknown }>, status = 200): Promise<T> {
    const res = await promise;
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as T;
  }

  /**
   * Isolated shop: tenant (default roles + default sector "Cozinha"), a custom READER role, MAIN and OTHER branches,
   * sectors BAR and DOCES, and products: burger (no sector = default), drink (BAR), pudding (DOCES), combo (DOCES) that
   * links the drink (BAR).
   */
  async function shop(name: string) {
    const org = await seedOrg(owner, name);
    await h.tenants.run({ tenantId: org.tenantId }, async () => {
      const provisioning = new TenantProvisioningService(prisma, h.scope);
      await provisioning.provisionDefaultRoles();
      await provisioning.provisionDefaultKitchenSector();
    });
    const reader = await owner.role.create({ data: { tenantId: org.tenantId, code: "READER", name: "Leitura", isSystem: false, status: "ACTIVE" } });
    const perms = await owner.permission.findMany({ where: { code: { in: ["order.read", "product.read"] } } });
    await owner.rolePermission.createMany({ data: perms.map((p) => ({ tenantId: org.tenantId, roleId: reader.id, permissionId: p.id })) });
    const actors = {
      owner: await login(org, "OWNER", [org.branchId, org.otherBranchId]),
      manager: await login(org, "MANAGER", [org.branchId, org.otherBranchId]),
      attendant: await login(org, "ATTENDANT", [org.branchId]),
      kitchen: await login(org, "KITCHEN", [org.branchId]),
      kitchenNoAccess: await login(org, "KITCHEN", []),
      reader: await login(org, "READER", [org.branchId]),
      nobody: await login(org, null, [org.branchId]),
    };
    const api = client(actors.owner);
    const sectors = await ok<KitchenSectorDto[]>(api.get("/kitchen-sectors"));
    const cozinha = sectors[0]!;
    const bar = await ok<KitchenSectorDto>(api.post("/kitchen-sectors", { name: "Bar", code: "bar", sortOrder: 1 }), 201);
    const doces = await ok<KitchenSectorDto>(api.post("/kitchen-sectors", { name: "Doces", code: "DOCES", sortOrder: 2 }), 201);
    const product = (body: Record<string, unknown>) => ok<ProductDto>(api.post("/products", body), 201);
    const burger = await product({ name: "X-Burger", code: "XB", basePrice: "25.00", optionGroups: [{ name: "Tamanho", minChoices: 1, maxChoices: 1, options: [{ name: "P" }, { name: "G", priceDelta: "4.00" }] }] });
    const drink = await product({ name: "Refri", code: "REFRI", basePrice: "6.00", kitchenSectorId: bar.id });
    const pudding = await product({ name: "Pudim", basePrice: "9.00", kitchenSectorId: doces.id });
    const combo = await product({
      name: "Combo Doce",
      basePrice: "30.00",
      kitchenSectorId: doces.id,
      optionGroups: [{ name: "Bebida", minChoices: 1, maxChoices: 1, options: [{ name: "Refri", linkedProductId: drink.id }] }],
    });
    return {
      org,
      actors,
      api,
      cozinha,
      bar,
      doces,
      burger,
      drink,
      pudding,
      combo,
      orders: `/branches/${org.branchId}/orders`,
      tickets: `/branches/${org.branchId}/kitchen-tickets`,
      branchSectors: `/branches/${org.branchId}/kitchen-sectors`,
    };
  }
  type Shop = Awaited<ReturnType<typeof shop>>;

  const burgerItem = (s: Shop, extra: Record<string, unknown> = {}) => ({ productId: s.burger.id, quantity: 2, optionIds: [s.burger.optionGroups[0]!.options[1]!.id], note: "sem cebola", ...extra });
  const drinkItem = (s: Shop) => ({ productId: s.drink.id, quantity: 1 });
  const puddingItem = (s: Shop) => ({ productId: s.pudding.id, quantity: 3 });
  const comboItem = (s: Shop) => ({ productId: s.combo.id, quantity: 1, optionIds: [s.combo.optionGroups[0]!.options[0]!.id] });

  /** M6: the confirmer needs an OPEN cash session (opened once; 409 = already open). Pays the total by PIX. */
  async function confirm(s: Shop, items: unknown[], as: Client = client(s.actors.attendant)): Promise<OrderDto> {
    const draft = await ok<OrderDto>(as.post(s.orders, { items }), 201);
    const cash = await as.post(`/branches/${s.org.branchId}/cash-sessions`, { openingAmount: "0.00" });
    if (cash.status !== 201 && cash.status !== 409) throw new Error(`cannot open the cash session: ${JSON.stringify(cash)}`);
    return ok<OrderDto>(as.post(`${s.orders}/${draft.id}/confirm`, { payments: draft.total === "0.00" ? [] : [{ method: "PIX", amount: draft.total }] }));
  }

  const ticketOf = (order: OrderDto, sectorId: string) => order.kitchenTickets.find((t) => t.sector.id === sectorId)!.id;
  const orderStatus = async (s: Shop, orderId: string) => (await ok<OrderDto>(client(s.actors.attendant).get(`${s.orders}/${orderId}`))).status;

  describe("authorization", () => {
    it("requires a token on every kitchen route", async () => {
      const b = `/branches/${randomUUID()}`;
      const id = randomUUID();
      const routes: [string, string][] = [
        ["GET", "/kitchen-sectors"],
        ["POST", "/kitchen-sectors"],
        ["PATCH", `/kitchen-sectors/${id}`],
        ...["make-default", "activate", "deactivate"].map((a): [string, string] => ["POST", `/kitchen-sectors/${id}/${a}`]),
        ["GET", `${b}/kitchen-sectors`],
        ["PUT", `${b}/kitchen-sectors/${id}`],
        ["GET", `${b}/kitchen-tickets`],
        ["GET", `${b}/kitchen-tickets/${id}`],
        ...["start", "ready", "print"].map((a): [string, string] => ["POST", `${b}/kitchen-tickets/${id}/${a}`]),
      ];
      for (const [method, path] of routes) expect(await http.request(path, { method }), `${method} ${path}`).toEqual({ status: 401, body: { error: "unauthenticated" } });
    });

    it("KITCHEN starts, readies and prints tickets but neither creates nor confirms orders nor manages sectors", async () => {
      const s = await shop("Cozinha permissões");
      const order = await confirm(s, [burgerItem(s)]);
      const kitchen = client(s.actors.kitchen);
      const ticket = order.kitchenTickets[0]!.id;
      expect((await kitchen.get(s.tickets)).status).toBe(200);
      expect((await kitchen.get(`${s.tickets}/${ticket}`)).status).toBe(200);
      expect((await kitchen.post(`${s.tickets}/${ticket}/start`)).body).toMatchObject({ status: "PREPARING" });
      expect((await kitchen.post(`${s.tickets}/${ticket}/ready`)).body).toMatchObject({ status: "READY" });
      expect((await kitchen.post(`${s.tickets}/${ticket}/print`)).status).toBe(200);
      expect((await kitchen.get("/kitchen-sectors")).status).toBe(200);
      expect((await kitchen.get(s.branchSectors)).status).toBe(200);
      expect(await kitchen.post(s.orders, {})).toEqual(FORBIDDEN);
      const draft = await ok<OrderDto>(client(s.actors.attendant).post(s.orders, { items: [burgerItem(s)] }), 201);
      expect(await kitchen.post(`${s.orders}/${draft.id}/confirm`, { payments: [] })).toEqual(FORBIDDEN);
      expect(await kitchen.post(`${s.orders}/${order.id}/deliver`)).toEqual(FORBIDDEN);
      expect(await kitchen.post("/kitchen-sectors", { name: "X", code: "X" })).toEqual(FORBIDDEN);
      expect(await kitchen.post(`/kitchen-sectors/${s.bar.id}/deactivate`)).toEqual(FORBIDDEN);
      expect(await kitchen.put(`${s.branchSectors}/${s.bar.id}`, { enabled: false })).toEqual(FORBIDDEN);
    });

    it("ATTENDANT, MANAGER and OWNER prepare too; without order.prepare (custom READER role, no role) = 403", async () => {
      const s = await shop("Preparo papéis");
      for (const role of ["attendant", "manager", "owner"] as const) {
        const order = await confirm(s, [burgerItem(s)]);
        const as = client(s.actors[role]);
        const ticket = order.kitchenTickets[0]!.id;
        expect((await as.post(`${s.tickets}/${ticket}/start`)).status, role).toBe(200);
        expect((await as.post(`${s.orders}/${order.id}/ready`)).status, role).toBe(200);
      }
      const order = await confirm(s, [burgerItem(s)]);
      const ticket = order.kitchenTickets[0]!.id;
      const reader = client(s.actors.reader);
      expect((await reader.get(`${s.tickets}/${ticket}`)).status).toBe(200);
      expect((await reader.post(`${s.tickets}/${ticket}/print`)).status).toBe(200); // print needs only order.read
      for (const path of [`${s.tickets}/${ticket}/start`, `${s.tickets}/${ticket}/ready`, `${s.orders}/${order.id}/start`, `${s.orders}/${order.id}/ready`]) {
        expect(await reader.post(path), path).toEqual(FORBIDDEN);
      }
      const nobody = client(s.actors.nobody);
      for (const [method, path] of [["GET", s.tickets], ["GET", `${s.tickets}/${ticket}`], ["POST", `${s.tickets}/${ticket}/start`], ["POST", `${s.tickets}/${ticket}/print`]] as const) {
        expect(await (method === "GET" ? nobody.get(path) : nobody.post(path)), `${method} ${path}`).toEqual(FORBIDDEN);
      }
      expect(await orderStatus(s, order.id)).toBe("CONFIRMED");
    });

    it("branch routes need access to THAT branch (403); a ticket of another branch or tenant is 404", async () => {
      const s = await shop("Escopo comandas");
      const foreign = await shop("Outro tenant comandas");
      const order = await confirm(s, [burgerItem(s)]);
      const foreignOrder = await confirm(foreign, [burgerItem(foreign)]);
      const ticket = order.kitchenTickets[0]!.id;
      const noAccess = client(s.actors.kitchenNoAccess);
      for (const path of [s.tickets, `${s.tickets}/${ticket}`, s.branchSectors]) expect(await noAccess.get(path), path).toEqual(FORBIDDEN);
      expect(await noAccess.post(`${s.tickets}/${ticket}/start`)).toEqual(FORBIDDEN);
      const kitchen = client(s.actors.kitchen);
      for (const branch of [s.org.otherBranchId, foreign.org.branchId, randomUUID(), "nao-uuid"]) {
        expect(await kitchen.get(`/branches/${branch}/kitchen-tickets`), branch).toEqual(FORBIDDEN);
      }
      // The owner reaches OTHER, but the ticket lives in MAIN: 404, as is another tenant's ticket in our branch.
      const ownerClient = client(s.actors.owner);
      const otherBranch = `/branches/${s.org.otherBranchId}/kitchen-tickets`;
      for (const path of [`${otherBranch}/${ticket}`]) expect(await ownerClient.get(path)).toEqual(NOT_FOUND);
      for (const action of ["start", "ready", "print"]) expect(await ownerClient.post(`${otherBranch}/${ticket}/${action}`), action).toEqual(NOT_FOUND);
      const foreignTicket = foreignOrder.kitchenTickets[0]!.id;
      expect(await kitchen.get(`${s.tickets}/${foreignTicket}`)).toEqual(NOT_FOUND);
      for (const action of ["start", "ready", "print"]) expect(await kitchen.post(`${s.tickets}/${foreignTicket}/${action}`), action).toEqual(NOT_FOUND);
      expect(await kitchen.get(`${s.tickets}/${randomUUID()}`)).toEqual(NOT_FOUND);
      expect(await kitchen.get(`${s.tickets}/nao-uuid`)).toEqual(NOT_FOUND);
      expect((await ok<Page<KitchenTicketDto>>(kitchen.get(s.tickets))).items.map((t) => t.id)).toEqual([ticket]);
      // Nothing moved in the other tenant.
      expect((await owner.kitchenTicket.findUniqueOrThrow({ where: { id: foreignTicket } })).printCount).toBe(0);
    });
  });

  describe("sectors (tenant)", () => {
    it("provisioning creates the default 'Cozinha' (COZINHA); list: default first, then sortOrder, then name", async () => {
      const s = await shop("Setores lista");
      await ok(s.api.post("/kitchen-sectors", { name: "Adega", code: "ADEGA", sortOrder: 1 }), 201);
      const list = await ok<KitchenSectorDto[]>(s.api.get("/kitchen-sectors"));
      expect(list.map((x) => [x.code, x.isDefault, x.status])).toEqual([
        ["COZINHA", true, "ACTIVE"],
        ["ADEGA", false, "ACTIVE"],
        ["BAR", false, "ACTIVE"],
        ["DOCES", false, "ACTIVE"],
      ]);
      expect(list[0]).toMatchObject({ name: "Cozinha", sortOrder: 0 });
      expect(Object.keys(list[0]!).sort()).toEqual(["code", "createdAt", "id", "isDefault", "name", "sortOrder", "status", "updatedAt"]);
      expect(await s.api.get("/kitchen-sectors?status=ACTIVE")).toMatchObject({ status: 400 });
    });

    it("creates and edits with strict bodies; duplicate code = 409, also in a race", async () => {
      const s = await shop("Setores CRUD");
      expect(s.bar).toMatchObject({ name: "Bar", code: "BAR", isDefault: false, status: "ACTIVE", sortOrder: 1 });
      expect(await s.api.post("/kitchen-sectors", { name: "Outro bar", code: " bar " })).toEqual({ status: 409, body: { error: "kitchen_sector_code_already_exists" } });
      expect(await s.api.post("/kitchen-sectors", { name: " ", code: "-X", sortOrder: 10000, isDefault: true, status: "INACTIVE" })).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "isDefault", issue: "unknown_field" },
            { field: "status", issue: "unknown_field" },
            { field: "name", issue: "too_short" },
            { field: "code", issue: "invalid_format" },
            { field: "sortOrder", issue: "invalid_value" },
          ],
        },
      });
      expect((await s.api.post("/kitchen-sectors", { name: "x".repeat(61), code: "LONGO" })).body).toMatchObject({ details: [{ field: "name", issue: "too_long" }] });
      const edited = await ok<KitchenSectorDto>(s.api.patch(`/kitchen-sectors/${s.bar.id}`, { name: "Bar & Drinks", code: "drinks", sortOrder: 5 }));
      expect(edited).toMatchObject({ id: s.bar.id, name: "Bar & Drinks", code: "DRINKS", sortOrder: 5 });
      expect(await ok<KitchenSectorDto>(s.api.patch(`/kitchen-sectors/${s.bar.id}`, {}))).toEqual(edited);
      expect(await s.api.patch(`/kitchen-sectors/${s.doces.id}`, { code: "DRINKS" })).toEqual({ status: 409, body: { error: "kitchen_sector_code_already_exists" } });
      expect((await s.api.patch(`/kitchen-sectors/${s.doces.id}`, { status: "INACTIVE" })).status).toBe(400);
      expect((await s.api.patch(`/kitchen-sectors/${s.doces.id}`, { isDefault: true })).status).toBe(400);
      const foreign = await shop("Setores outro tenant");
      expect(await s.api.patch(`/kitchen-sectors/${foreign.bar.id}`, { name: "Meu" })).toEqual(NOT_FOUND);
      expect(await s.api.patch(`/kitchen-sectors/${randomUUID()}`, { name: "Meu" })).toEqual(NOT_FOUND);
      expect(await s.api.post(`/kitchen-sectors/nao-uuid/activate`)).toEqual(NOT_FOUND);
      // The same code in another tenant is fine.
      expect((await foreign.api.post("/kitchen-sectors", { name: "Drinks", code: "DRINKS" })).status).toBe(201);

      const race = await Promise.all([1, 2].map(() => s.api.post("/kitchen-sectors", { name: "Corrida", code: "CORRIDA" })));
      expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(race.find((r) => r.status === 409)?.body).toEqual({ error: "kitchen_sector_code_already_exists" });
    });

    it("activate/deactivate are idempotent; the default cannot be deactivated", async () => {
      const s = await shop("Setores status");
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.bar.id}/deactivate`))).toMatchObject({ status: "INACTIVE" });
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.bar.id}/deactivate`))).toMatchObject({ status: "INACTIVE" });
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.bar.id}/activate`))).toMatchObject({ status: "ACTIVE" });
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.bar.id}/activate`))).toMatchObject({ status: "ACTIVE" });
      expect(await s.api.post(`/kitchen-sectors/${s.cozinha.id}/deactivate`)).toEqual(DEFAULT_REQUIRED);
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.cozinha.id}/activate`))).toMatchObject({ status: "ACTIVE", isDefault: true });
    });

    it("make-default swaps the default atomically; INACTIVE cannot become default; parallel swaps leave exactly one default", async () => {
      const s = await shop("Setores padrão");
      const swapped = await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.bar.id}/make-default`));
      expect(swapped).toMatchObject({ id: s.bar.id, isDefault: true });
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.bar.id}/make-default`))).toMatchObject({ isDefault: true });
      const list = await ok<KitchenSectorDto[]>(s.api.get("/kitchen-sectors"));
      expect(list.map((x) => [x.code, x.isDefault])).toEqual([["BAR", true], ["COZINHA", false], ["DOCES", false]]);
      // The old default is a regular sector now: it can be deactivated; the new one cannot.
      expect(await ok<KitchenSectorDto>(s.api.post(`/kitchen-sectors/${s.cozinha.id}/deactivate`))).toMatchObject({ status: "INACTIVE" });
      expect(await s.api.post(`/kitchen-sectors/${s.bar.id}/deactivate`)).toEqual(DEFAULT_REQUIRED);
      expect(await s.api.post(`/kitchen-sectors/${s.cozinha.id}/make-default`)).toEqual({ status: 409, body: { error: "kitchen_sector_inactive" } });
      expect(await s.api.post(`/kitchen-sectors/${randomUUID()}/make-default`)).toEqual(NOT_FOUND);

      for (let round = 0; round < 5; round++) {
        const results = await Promise.all([s.cozinha.id, s.doces.id, s.bar.id].map((id) => s.api.post(`/kitchen-sectors/${id}/${id === s.cozinha.id ? "activate" : "make-default"}`)));
        expect(results.map((r) => r.status), `round ${round}`).toEqual([200, 200, 200]);
        const defaults = await owner.kitchenSector.findMany({ where: { tenantId: s.org.tenantId, isDefault: true } });
        expect(defaults, `round ${round}`).toHaveLength(1);
        expect([s.doces.id, s.bar.id]).toContain(defaults[0]!.id);
        await ok(s.api.post(`/kitchen-sectors/${s.cozinha.id}/make-default`));
        await Promise.all([s.cozinha.id, s.bar.id].map((id) => s.api.post(`/kitchen-sectors/${id}/make-default`)));
        expect(await owner.kitchenSector.count({ where: { tenantId: s.org.tenantId, isDefault: true } }), `round ${round}`).toBe(1);
      }
    });
  });

  describe("sectors in the branch", () => {
    it("lists every tenant sector with enabled/receivesTickets; turns a sector off and on; the default cannot be turned off", async () => {
      const s = await shop("Setores filial");
      const manager = client(s.actors.manager);
      const initial = await ok<BranchKitchenSectorDto[]>(manager.get(s.branchSectors));
      expect(initial.map((x) => [x.sector.code, x.enabled, x.receivesTickets])).toEqual([["COZINHA", true, true], ["BAR", true, true], ["DOCES", true, true]]);
      expect(await ok<BranchKitchenSectorDto>(manager.put(`${s.branchSectors}/${s.bar.id}`, { enabled: false }))).toMatchObject({ sector: { id: s.bar.id }, enabled: false, receivesTickets: false });
      expect(await ok<BranchKitchenSectorDto>(manager.put(`${s.branchSectors}/${s.bar.id}`, { enabled: false }))).toMatchObject({ enabled: false });
      expect(await manager.put(`${s.branchSectors}/${s.cozinha.id}`, { enabled: false })).toEqual(DEFAULT_REQUIRED);
      expect(await ok<BranchKitchenSectorDto>(manager.put(`${s.branchSectors}/${s.cozinha.id}`, { enabled: true }))).toMatchObject({ enabled: true, receivesTickets: true });
      await ok(s.api.post(`/kitchen-sectors/${s.doces.id}/deactivate`));
      const after = await ok<BranchKitchenSectorDto[]>(manager.get(s.branchSectors));
      expect(after.map((x) => [x.sector.code, x.enabled, x.receivesTickets])).toEqual([["COZINHA", true, true], ["BAR", false, false], ["DOCES", true, false]]);
      // Other branch is untouched.
      const other = await ok<BranchKitchenSectorDto[]>(manager.get(`/branches/${s.org.otherBranchId}/kitchen-sectors`));
      expect(other.map((x) => [x.sector.code, x.enabled])).toEqual([["COZINHA", true], ["BAR", true], ["DOCES", true]]);
      expect(await ok<BranchKitchenSectorDto>(manager.put(`${s.branchSectors}/${s.bar.id}`, { enabled: true }))).toMatchObject({ enabled: true, receivesTickets: true });
      expect(await owner.branchKitchenSector.count({ where: { tenantId: s.org.tenantId } })).toBe(2); // BAR row + COZINHA row (no delete)

      expect((await manager.put(`${s.branchSectors}/${s.bar.id}`, { enabled: "no" })).body).toMatchObject({ details: [{ field: "enabled", issue: "invalid_type" }] });
      expect((await manager.put(`${s.branchSectors}/${s.bar.id}`, {})).body).toMatchObject({ details: [{ field: "enabled", issue: "required" }] });
      const foreign = await shop("Filial outro tenant");
      expect(await manager.put(`${s.branchSectors}/${foreign.bar.id}`, { enabled: false })).toEqual(NOT_FOUND);
      expect(await client(s.actors.attendant).put(`${s.branchSectors}/${s.bar.id}`, { enabled: false })).toEqual(FORBIDDEN);
      expect(await client(s.actors.attendant).put(`/branches/${s.org.otherBranchId}/kitchen-sectors/${s.bar.id}`, { enabled: false })).toEqual(FORBIDDEN);
    });

    it("after make-default, the new default always receives tickets even if it was turned off in the branch", async () => {
      const s = await shop("Padrão desligado");
      await ok(client(s.actors.manager).put(`${s.branchSectors}/${s.bar.id}`, { enabled: false }));
      await ok(s.api.post(`/kitchen-sectors/${s.bar.id}/make-default`));
      const list = await ok<BranchKitchenSectorDto[]>(s.api.get(s.branchSectors));
      expect(list[0]).toMatchObject({ sector: { code: "BAR", isDefault: true }, enabled: true, receivesTickets: true });
      const order = await confirm(s, [burgerItem(s)]);
      expect(order.kitchenTickets.map((t) => t.sector.code)).toEqual(["BAR"]);
    });
  });

  describe("product kitchenSectorId", () => {
    it("is set on create/update (null = default) and must be a sector of the tenant (400 invalid_value)", async () => {
      const s = await shop("Produto setor");
      expect(s.drink.kitchenSectorId).toBe(s.bar.id);
      expect(s.burger.kitchenSectorId).toBeNull();
      expect(await ok<ProductDto>(s.api.patch(`/products/${s.drink.id}`, { kitchenSectorId: null }))).toMatchObject({ kitchenSectorId: null });
      expect(await ok<ProductDto>(s.api.patch(`/products/${s.drink.id}`, { kitchenSectorId: s.doces.id }))).toMatchObject({ kitchenSectorId: s.doces.id });
      const listed = await ok<Page<{ id: string; kitchenSectorId: string | null }>>(s.api.get("/products"));
      expect(listed.items.find((p) => p.id === s.drink.id)?.kitchenSectorId).toBe(s.doces.id);
      // Any status: an INACTIVE sector is accepted (the item then goes to the default).
      await ok(s.api.post(`/kitchen-sectors/${s.bar.id}/deactivate`));
      expect(await ok<ProductDto>(s.api.patch(`/products/${s.drink.id}`, { kitchenSectorId: s.bar.id }))).toMatchObject({ kitchenSectorId: s.bar.id });

      const foreign = await shop("Produto setor alheio");
      const invalid = { status: 400, body: { error: "validation_failed", details: [{ field: "kitchenSectorId", issue: "invalid_value" }] } };
      expect(await s.api.patch(`/products/${s.drink.id}`, { kitchenSectorId: foreign.bar.id })).toEqual(invalid);
      expect(await s.api.patch(`/products/${s.drink.id}`, { kitchenSectorId: randomUUID() })).toEqual(invalid);
      expect(await s.api.post("/products", { name: "X", basePrice: "1.00", kitchenSectorId: foreign.bar.id })).toEqual(invalid);
      expect((await s.api.post("/products", { name: "X", basePrice: "1.00", kitchenSectorId: "bar" })).body).toMatchObject({ details: [{ field: "kitchenSectorId", issue: "invalid_format" }] });
      expect((await owner.product.findUniqueOrThrow({ where: { id: s.drink.id } })).kitchenSectorId).toBe(s.bar.id);
    });
  });

  describe("confirmation creates one ticket per sector", () => {
    it("splits the items by effective sector, only with that sector's items, without prices", async () => {
      const s = await shop("Comandas confirmação");
      const order = await confirm(s, [burgerItem(s), drinkItem(s), puddingItem(s), drinkItem(s)]);
      expect(order.status).toBe("CONFIRMED");
      expect(order.kitchenTickets.map((t) => [t.sector.code, t.sector.name, t.status]).sort()).toEqual([
        ["BAR", "Bar", "WAITING"],
        ["COZINHA", "Cozinha", "WAITING"],
        ["DOCES", "Doces", "WAITING"],
      ]);
      const kitchen = client(s.actors.kitchen);
      const byCode = async (code: string) => ok<KitchenTicketDto>(kitchen.get(`${s.tickets}/${order.kitchenTickets.find((t) => t.sector.code === code)!.id}`));
      const cozinha = await byCode("COZINHA");
      expect(Object.keys(cozinha).sort()).toEqual(TICKET_KEYS);
      expect(cozinha).toMatchObject({
        orderId: order.id,
        orderNumber: order.number,
        businessDate: order.businessDate,
        sector: { id: s.cozinha.id, name: "Cozinha", code: "COZINHA" },
        status: "WAITING",
        startedAt: null,
        readyAt: null,
        cancelledAt: null,
        printCount: 0,
        lastPrintedAt: null,
      });
      expect(cozinha.items).toEqual([
        { orderItemId: order.items[0]!.id, productName: "X-Burger", productCode: "XB", quantity: 2, options: [{ groupName: "Tamanho", name: "G" }], note: "sem cebola" },
      ]);
      expect(Object.keys(cozinha.items[0]!).sort()).toEqual(["note", "options", "orderItemId", "productCode", "productName", "quantity"]);
      expect((await byCode("BAR")).items.map((i) => i.orderItemId)).toEqual([order.items[1]!.id, order.items[3]!.id]);
      expect((await byCode("DOCES")).items).toMatchObject([{ productName: "Pudim", quantity: 3, productCode: null, options: [], note: null }]);
      expect(JSON.stringify(await byCode("COZINHA"))).not.toMatch(/price|Price|total|"25\.00"|"29\.00"/);
      // Every order item is in exactly one ticket.
      expect(await owner.kitchenTicketItem.count({ where: { orderId: order.id } })).toBe(order.items.length);
    });

    it("a combo goes whole to the main product's sector (the linked drink of BAR does not split it)", async () => {
      const s = await shop("Combo setor");
      const order = await confirm(s, [comboItem(s)]);
      expect(order.kitchenTickets.map((t) => t.sector.code)).toEqual(["DOCES"]);
      const ticket = await ok<KitchenTicketDto>(client(s.actors.kitchen).get(`${s.tickets}/${order.kitchenTickets[0]!.id}`));
      expect(ticket.items).toEqual([{ orderItemId: order.items[0]!.id, productName: "Combo Doce", productCode: null, quantity: 1, options: [{ groupName: "Bebida", name: "Refri" }], note: null }]);
    });

    it("INACTIVE sector or sector turned off in the branch -> the default; other branches keep their routing", async () => {
      const s = await shop("Setor fallback");
      await ok(s.api.post(`/kitchen-sectors/${s.doces.id}/deactivate`));
      await ok(client(s.actors.manager).put(`${s.branchSectors}/${s.bar.id}`, { enabled: false }));
      const order = await confirm(s, [drinkItem(s), puddingItem(s), burgerItem(s)]);
      expect(order.kitchenTickets.map((t) => t.sector.code)).toEqual(["COZINHA"]);
      const ticket = await ok<KitchenTicketDto>(client(s.actors.kitchen).get(`${s.tickets}/${order.kitchenTickets[0]!.id}`));
      expect(ticket.items.map((i) => i.productName)).toEqual(["Refri", "Pudim", "X-Burger"]);

      // OTHER branch: BAR is on there.
      const otherOrders = `/branches/${s.org.otherBranchId}/orders`;
      const manager = client(s.actors.manager);
      const draft = await ok<OrderDto>(manager.post(otherOrders, { items: [drinkItem(s)] }), 201);
      await manager.post(`/branches/${s.org.otherBranchId}/cash-sessions`, { openingAmount: "0.00" });
      const other = await ok<OrderDto>(manager.post(`${otherOrders}/${draft.id}/confirm`, { payments: [{ method: "PIX", amount: draft.total }] }));
      expect(other.kitchenTickets.map((t) => t.sector.code)).toEqual(["BAR"]);
    });

    it("existing tickets keep their sector and its name after the product or the sector changes", async () => {
      const s = await shop("Comanda congelada");
      const order = await confirm(s, [drinkItem(s)]);
      await ok(s.api.patch(`/products/${s.drink.id}`, { kitchenSectorId: s.doces.id, name: "Refri Lata" }));
      await ok(s.api.patch(`/kitchen-sectors/${s.bar.id}`, { name: "Bar Novo", code: "BARNOVO" }));
      await ok(s.api.post(`/kitchen-sectors/${s.bar.id}/deactivate`));
      const ticket = await ok<KitchenTicketDto>(client(s.actors.kitchen).get(`${s.tickets}/${order.kitchenTickets[0]!.id}`));
      expect(ticket).toMatchObject({ sector: { id: s.bar.id, name: "Bar", code: "BAR" }, items: [{ productName: "Refri" }] });
      expect((await ok<OrderDto>(s.api.get(`${s.orders}/${order.id}`))).kitchenTickets).toEqual(order.kitchenTickets);
      const next = await confirm(s, [drinkItem(s)]);
      expect(next.kitchenTickets.map((t) => t.sector.code)).toEqual(["DOCES"]);
    });

    it("drafts and the payment-mismatch path create no tickets", async () => {
      const s = await shop("Sem comanda");
      const as = client(s.actors.attendant);
      const draft = await ok<OrderDto>(as.post(s.orders, { items: [burgerItem(s)] }), 201);
      expect(draft.kitchenTickets).toEqual([]);
      await as.post(`/branches/${s.org.branchId}/cash-sessions`, { openingAmount: "0.00" });
      expect((await as.post(`${s.orders}/${draft.id}/confirm`, { payments: [{ method: "PIX", amount: "1.00" }] })).status).toBe(409);
      expect(await owner.kitchenTicket.count({ where: { orderId: draft.id } })).toBe(0);
    });
  });

  describe("ticket flow and derived order status", () => {
    it("start/ready per ticket derives CONFIRMED -> PREPARING -> READY with the order timestamps; then deliver", async () => {
      const s = await shop("Fluxo comandas");
      const order = await confirm(s, [burgerItem(s), drinkItem(s)]);
      const kitchen = client(s.actors.kitchen);
      const food = ticketOf(order, s.cozinha.id);
      const bar = ticketOf(order, s.bar.id);
      expect(await client(s.actors.attendant).post(`${s.orders}/${order.id}/deliver`)).toEqual(ORDER_TRANSITION);
      expect(await kitchen.post(`${s.tickets}/${food}/ready`)).toEqual(TICKET_TRANSITION);

      clock.fixed = new Date("2026-11-10T15:00:00.000Z");
      expect(await ok<KitchenTicketDto>(kitchen.post(`${s.tickets}/${food}/start`))).toMatchObject({ status: "PREPARING", startedAt: "2026-11-10T15:00:00.000Z" });
      expect(await kitchen.post(`${s.tickets}/${food}/start`)).toEqual(TICKET_TRANSITION);
      let current = await ok<OrderDto>(kitchen.get(`${s.orders}/${order.id}`));
      expect(current).toMatchObject({ status: "PREPARING", preparingAt: "2026-11-10T15:00:00.000Z", readyAt: null });

      clock.fixed = new Date("2026-11-10T15:05:00.000Z");
      expect(await ok<KitchenTicketDto>(kitchen.post(`${s.tickets}/${food}/ready`))).toMatchObject({ status: "READY", readyAt: "2026-11-10T15:05:00.000Z" });
      expect(await kitchen.post(`${s.tickets}/${food}/ready`)).toEqual(TICKET_TRANSITION);
      expect(await kitchen.post(`${s.tickets}/${food}/start`)).toEqual(TICKET_TRANSITION);
      current = await ok<OrderDto>(kitchen.get(`${s.orders}/${order.id}`));
      expect(current).toMatchObject({ status: "PREPARING", preparingAt: "2026-11-10T15:00:00.000Z", readyAt: null });
      expect(current.kitchenTickets.map((t) => [t.sector.code, t.status]).sort()).toEqual([["BAR", "WAITING"], ["COZINHA", "READY"]]);
      expect(await client(s.actors.attendant).post(`${s.orders}/${order.id}/deliver`)).toEqual(ORDER_TRANSITION);

      clock.fixed = new Date("2026-11-10T15:07:00.000Z");
      await ok(kitchen.post(`${s.tickets}/${bar}/start`));
      expect(await orderStatus(s, order.id)).toBe("PREPARING");
      clock.fixed = new Date("2026-11-10T15:08:00.000Z");
      await ok(kitchen.post(`${s.tickets}/${bar}/ready`));
      current = await ok<OrderDto>(kitchen.get(`${s.orders}/${order.id}`));
      expect(current).toMatchObject({ status: "READY", preparingAt: "2026-11-10T15:00:00.000Z", readyAt: "2026-11-10T15:08:00.000Z" });
      expect(await ok<OrderDto>(client(s.actors.attendant).post(`${s.orders}/${order.id}/deliver`))).toMatchObject({ status: "DELIVERED" });
      expect(await kitchen.post(`${s.tickets}/${bar}/ready`)).toEqual(TICKET_TRANSITION);
    });

    it("order shortcuts: start moves the WAITING tickets, ready moves every open ticket; nothing to move = 409", async () => {
      const s = await shop("Atalhos");
      const as = client(s.actors.attendant);
      const order = await confirm(s, [burgerItem(s), drinkItem(s), puddingItem(s)]);
      const food = ticketOf(order, s.cozinha.id);
      await ok(client(s.actors.kitchen).post(`${s.tickets}/${food}/start`));
      await ok(client(s.actors.kitchen).post(`${s.tickets}/${food}/ready`));
      clock.fixed = new Date("2026-11-10T16:00:00.000Z");
      const started = await ok<OrderDto>(as.post(`${s.orders}/${order.id}/start`));
      expect(started.status).toBe("PREPARING");
      expect(started.kitchenTickets.map((t) => [t.sector.code, t.status]).sort()).toEqual([["BAR", "PREPARING"], ["COZINHA", "READY"], ["DOCES", "PREPARING"]]);
      expect(await as.post(`${s.orders}/${order.id}/start`)).toEqual(ORDER_TRANSITION);
      const ready = await ok<OrderDto>(as.post(`${s.orders}/${order.id}/ready`));
      expect(ready.status).toBe("READY");
      expect(ready.kitchenTickets.every((t) => t.status === "READY")).toBe(true);
      expect(await as.post(`${s.orders}/${order.id}/ready`)).toEqual(ORDER_TRANSITION);
      expect(await as.post(`${s.orders}/${order.id}/start`)).toEqual(ORDER_TRANSITION);

      // `ready` straight from CONFIRMED: every ticket READY (start and ready recorded together) and the order walks
      // CONFIRMED -> PREPARING -> READY in the same transaction.
      const fresh = await confirm(s, [burgerItem(s), drinkItem(s)]);
      clock.fixed = new Date("2026-11-10T16:30:00.000Z");
      const done = await ok<OrderDto>(as.post(`${s.orders}/${fresh.id}/ready`));
      expect(done).toMatchObject({ status: "READY", preparingAt: "2026-11-10T16:30:00.000Z", readyAt: "2026-11-10T16:30:00.000Z" });
      const ticket = await ok<KitchenTicketDto>(as.get(`${s.tickets}/${done.kitchenTickets[0]!.id}`));
      expect(ticket).toMatchObject({ status: "READY", startedAt: "2026-11-10T16:30:00.000Z", readyAt: "2026-11-10T16:30:00.000Z" });
    });

    it("an order confirmed before M7 (no tickets, created via SQL) keeps the M5 flow", async () => {
      const s = await shop("Pedido legado");
      const as = client(s.actors.attendant);
      const draft = await ok<OrderDto>(as.post(s.orders, { items: [burgerItem(s)] }), 201);
      await owner.$executeRaw`
        UPDATE orders SET status = 'CONFIRMED', number = 9001, business_date = DATE '2026-11-01', confirmed_at = now(), updated_at = now()
        WHERE id = ${draft.id}::uuid`;
      const legacy = await ok<OrderDto>(as.get(`${s.orders}/${draft.id}`));
      expect(legacy).toMatchObject({ status: "CONFIRMED", kitchenTickets: [] });
      expect(await as.post(`${s.orders}/${draft.id}/ready`)).toEqual(ORDER_TRANSITION);
      expect(await ok<OrderDto>(client(s.actors.kitchen).post(`${s.orders}/${draft.id}/start`))).toMatchObject({ status: "PREPARING", kitchenTickets: [] });
      expect(await as.post(`${s.orders}/${draft.id}/start`)).toEqual(ORDER_TRANSITION);
      expect(await ok<OrderDto>(as.post(`${s.orders}/${draft.id}/ready`))).toMatchObject({ status: "READY" });
      expect(await ok<OrderDto>(as.post(`${s.orders}/${draft.id}/deliver`))).toMatchObject({ status: "DELIVERED" });
      expect(await owner.kitchenTicket.count({ where: { orderId: draft.id } })).toBe(0);
      expect((await ok<Page<KitchenTicketDto>>(as.get(s.tickets))).items).toEqual([]);
    });

    it("lists tickets in arrival order, filtered by sector, status list and business day, paginated", async () => {
      const s = await shop("Fila comandas");
      clock.fixed = new Date("2026-11-09T23:00:00.000Z"); // 20:00 in São Paulo, day 2026-11-09
      const first = await confirm(s, [burgerItem(s), drinkItem(s)]);
      clock.fixed = new Date("2026-11-10T13:00:00.000Z");
      const second = await confirm(s, [drinkItem(s)]);
      clock.fixed = new Date("2026-11-10T13:01:00.000Z");
      const third = await confirm(s, [burgerItem(s)]);
      clock.fixed = null;
      await ok(client(s.actors.kitchen).post(`${s.tickets}/${ticketOf(third, s.cozinha.id)}/start`));
      const kitchen = client(s.actors.kitchen);
      const ids = async (query = "") => (await ok<Page<KitchenTicketDto>>(kitchen.get(`${s.tickets}${query}`))).items.map((t) => t.id);
      const firstTickets = [...first.kitchenTickets].map((t) => t.id);
      expect(await ids()).toEqual([...firstTickets, second.kitchenTickets[0]!.id, third.kitchenTickets[0]!.id]);
      expect(await ids(`?sectorId=${s.bar.id}`)).toEqual([ticketOf(first, s.bar.id), second.kitchenTickets[0]!.id]);
      expect(await ids("?status=PREPARING")).toEqual([third.kitchenTickets[0]!.id]);
      expect(await ids("?status=WAITING,PREPARING&businessDate=2026-11-10")).toEqual([second.kitchenTickets[0]!.id, third.kitchenTickets[0]!.id]);
      expect(await ids("?businessDate=2026-11-09")).toEqual(firstTickets);
      expect(await ids("?businessDate=2026-11-08")).toEqual([]);
      const page = await ok<Page<KitchenTicketDto>>(kitchen.get(`${s.tickets}?pageSize=2&page=2`));
      expect(page).toMatchObject({ page: 2, pageSize: 2, total: 4, totalPages: 2 });
      expect(page.items.map((t) => t.id)).toEqual([second.kitchenTickets[0]!.id, third.kitchenTickets[0]!.id]);
      expect((await kitchen.get(`${s.tickets}?status=EDITING`)).body).toMatchObject({ details: [{ field: "status", issue: "invalid_value" }] });
      expect((await kitchen.get(`${s.tickets}?sectorId=bar`)).body).toMatchObject({ details: [{ field: "sectorId", issue: "invalid_format" }] });
      expect((await kitchen.get(`${s.tickets}?businessDate=2026-02-30`)).body).toMatchObject({ details: [{ field: "businessDate", issue: "invalid_value" }] });
      expect((await kitchen.get(`${s.tickets}?branchId=x`)).body).toMatchObject({ details: [{ field: "branchId", issue: "unknown_field" }] });
    });
  });

  describe("cancellation", () => {
    it("cancelling the order cancels every ticket (nothing is deleted); the tickets then refuse start/ready and print the warning", async () => {
      const s = await shop("Cancelar comandas");
      const order = await confirm(s, [burgerItem(s), drinkItem(s)]);
      const kitchen = client(s.actors.kitchen);
      const food = ticketOf(order, s.cozinha.id);
      const bar = ticketOf(order, s.bar.id);
      await ok(kitchen.post(`${s.tickets}/${food}/start`));
      clock.fixed = new Date("2026-11-10T18:00:00.000Z");
      const cancelled = await ok<OrderDto>(client(s.actors.manager).post(`${s.orders}/${order.id}/cancel`, { reason: "cliente desistiu" }));
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.kitchenTickets.map((t) => t.status)).toEqual(["CANCELLED", "CANCELLED"]);
      const ticket = await ok<KitchenTicketDto>(kitchen.get(`${s.tickets}/${food}`));
      expect(ticket).toMatchObject({ status: "CANCELLED", cancelledAt: "2026-11-10T18:00:00.000Z" });
      expect(ticket.startedAt).not.toBeNull();
      for (const id of [food, bar]) {
        expect(await kitchen.post(`${s.tickets}/${id}/start`)).toEqual(TICKET_TRANSITION);
        expect(await kitchen.post(`${s.tickets}/${id}/ready`)).toEqual(TICKET_TRANSITION);
      }
      expect(await client(s.actors.attendant).post(`${s.orders}/${order.id}/start`)).toEqual(ORDER_TRANSITION);
      const printed = await ok<KitchenTicketPrintDto>(kitchen.post(`${s.tickets}/${bar}/print`));
      expect(printed.lines[0]!.trim()).toBe("*** CANCELADO ***");
      expect(printed.ticket.status).toBe("CANCELLED");
      expect(await owner.kitchenTicket.count({ where: { orderId: order.id } })).toBe(2);
      expect(await owner.kitchenTicketItem.count({ where: { orderId: order.id } })).toBe(2);
    });
  });

  describe("print", () => {
    it("counts copies (1 = original, then '2ª VIA'), 48 columns, local time of the branch, no prices", async () => {
      const s = await shop("Impressão");
      clock.fixed = new Date("2026-11-10T02:30:00.000Z"); // 23:30 of 2026-11-09 in São Paulo
      const order = await confirm(s, [burgerItem(s, { note: "Sem cebola, ponto da carne bem passado e pão sem gergelim por favor" }), drinkItem(s)]);
      clock.fixed = new Date("2026-11-10T02:40:00.000Z");
      const kitchen = client(s.actors.kitchen);
      const food = ticketOf(order, s.cozinha.id);
      const first = await ok<KitchenTicketPrintDto>(kitchen.post(`${s.tickets}/${food}/print`));
      expect(first.copyNumber).toBe(1);
      expect(first.ticket).toMatchObject({ id: food, printCount: 1, lastPrintedAt: "2026-11-10T02:40:00.000Z" });
      const center = (text: string) => " ".repeat(Math.floor((48 - text.length) / 2)) + text;
      expect(first.lines.slice(0, 3)).toEqual([center("COZINHA"), center(`PEDIDO #${order.number}`), "09/11/2026 23:30"]);
      expect(first.lines).toContain("2x X-Burger");
      expect(first.lines).toContain("   Tamanho: G");
      expect(first.lines.some((l) => l.startsWith("   OBS: Sem cebola"))).toBe(true);
      expect(first.lines.every((l) => [...l].length <= 48)).toBe(true);
      expect(first.lines.join("\n")).not.toMatch(/VIA|CANCELADO|R\$|25\.00|29\.00|58\.00/);
      expect(first.lines.join("\n")).not.toContain("Refri"); // other sector

      const second = await ok<KitchenTicketPrintDto>(kitchen.post(`${s.tickets}/${food}/print`));
      expect(second.copyNumber).toBe(2);
      expect(second.lines[0]!.trim()).toBe("2ª VIA");
      expect(second.ticket.printCount).toBe(2);
      // Printing never changes the status (nor the order).
      expect(second.ticket.status).toBe("WAITING");
      expect(await orderStatus(s, order.id)).toBe("CONFIRMED");
    });

    it("parallel prints of the same ticket get distinct copies 1..N, never repeated", async () => {
      const s = await shop("Impressão paralela");
      const order = await confirm(s, [burgerItem(s)]);
      const ticket = order.kitchenTickets[0]!.id;
      const kitchen = client(s.actors.kitchen);
      const pair = await Promise.all([1, 2].map(() => ok<KitchenTicketPrintDto>(kitchen.post(`${s.tickets}/${ticket}/print`))));
      expect(pair.map((p) => p.copyNumber).sort()).toEqual([1, 2]);
      const many = await Promise.all(Array.from({ length: 8 }, () => ok<KitchenTicketPrintDto>(kitchen.post(`${s.tickets}/${ticket}/print`))));
      expect(many.map((p) => p.copyNumber).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
      expect((await owner.kitchenTicket.findUniqueOrThrow({ where: { id: ticket } })).printCount).toBe(10);
    });
  });

  describe("concurrency", () => {
    it("starting two tickets of the same order in parallel: both succeed and the order is PREPARING once", async () => {
      const s = await shop("Paralelo start");
      for (let round = 0; round < 5; round++) {
        const order = await confirm(s, [burgerItem(s), drinkItem(s), puddingItem(s)]);
        const kitchen = client(s.actors.kitchen);
        const results = await Promise.all(order.kitchenTickets.map((t) => kitchen.post(`${s.tickets}/${t.id}/start`)));
        expect(results.map((r) => r.status), `round ${round}`).toEqual([200, 200, 200]);
        const after = await ok<OrderDto>(kitchen.get(`${s.orders}/${order.id}`));
        expect(after.status).toBe("PREPARING");
        expect(after.kitchenTickets.every((t) => t.status === "PREPARING")).toBe(true);
        const readies = await Promise.all(order.kitchenTickets.map((t) => kitchen.post(`${s.tickets}/${t.id}/ready`)));
        expect(readies.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(await orderStatus(s, order.id)).toBe("READY");
      }
    });

    it("ready of the last ticket x cancel of the order: always a coherent final state", async () => {
      const s = await shop("Paralelo ready cancel");
      const kitchen = client(s.actors.kitchen);
      const manager = client(s.actors.manager);
      for (let round = 0; round < 6; round++) {
        const order = await confirm(s, [burgerItem(s), drinkItem(s)]);
        const [food, bar] = [ticketOf(order, s.cozinha.id), ticketOf(order, s.bar.id)];
        await ok(kitchen.post(`${s.tickets}/${food}/start`));
        await ok(kitchen.post(`${s.tickets}/${food}/ready`));
        await ok(kitchen.post(`${s.tickets}/${bar}/start`));
        const [ready, cancel] = await Promise.all([kitchen.post(`${s.tickets}/${bar}/ready`), manager.post(`${s.orders}/${order.id}/cancel`, { reason: "corrida" })]);
        expect(cancel.status, `round ${round}`).toBe(200); // READY and PREPARING are both cancellable
        expect([200, 409]).toContain(ready.status);
        const final = await owner.order.findUniqueOrThrow({ where: { id: order.id }, include: { kitchenTickets: true } });
        expect(final.status).toBe("CANCELLED");
        expect(final.kitchenTickets.map((t) => t.status)).toEqual(["CANCELLED", "CANCELLED"]);
        // If the ready won, it was fully applied before the cancel (order READY recorded); if it lost, it changed nothing.
        expect(final.readyAt !== null, `round ${round}`).toBe(ready.status === 200);
        expect(final.kitchenTickets.find((t) => t.id === bar)!.readyAt !== null).toBe(ready.status === 200);
      }
    });

    it("confirm x deactivating the sector: a deactivation in progress is waited for and the item goes to the default", async () => {
      const s = await shop("Confirmar x desativar");
      const as = client(s.actors.attendant);
      await as.post(`/branches/${s.org.branchId}/cash-sessions`, { openingAmount: "0.00" });
      const draft = await ok<OrderDto>(as.post(s.orders, { items: [drinkItem(s)] }), 201);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let updated!: (xid: string) => void;
      const didUpdate = new Promise<string>((resolve) => (updated = resolve));
      const deactivation = owner.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE kitchen_sectors SET status = 'INACTIVE', updated_at = now() WHERE tenant_id = ${s.org.tenantId}::uuid AND id = ${s.bar.id}::uuid`;
          const [row] = await tx.$queryRaw<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
          updated(row!.xid);
          await gate;
        },
        { timeout: 20_000 },
      );
      const xid = await didUpdate;
      const confirming = as.post(`${s.orders}/${draft.id}/confirm`, { payments: [{ method: "PIX", amount: draft.total }] });
      // Wait until the confirmation is blocked behind the uncommitted UPDATE (its FOR SHARE on the sector rows waits for
      // this transaction id). Without the FOR SHARE it would not wait, read BAR as ACTIVE and this test would fail.
      let blocked = false;
      for (let i = 0; i < 60 && !blocked; i++) {
        const [row] = await owner.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = ${xid}`;
        blocked = (row?.waiting ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      release();
      await deactivation;
      const confirmed = await ok<OrderDto>(confirming);
      expect(confirmed.kitchenTickets.map((t) => t.sector.code)).toEqual(["COZINHA"]);
    });

    it("confirm x deactivate (and branch toggle) in parallel never fails and routes to BAR or the default", async () => {
      const s = await shop("Paralelo confirmar desativar");
      const as = client(s.actors.attendant);
      await as.post(`/branches/${s.org.branchId}/cash-sessions`, { openingAmount: "0.00" });
      for (let round = 0; round < 6; round++) {
        await ok(s.api.post(`/kitchen-sectors/${s.bar.id}/activate`));
        await ok(client(s.actors.manager).put(`${s.branchSectors}/${s.bar.id}`, { enabled: true }));
        const draft = await ok<OrderDto>(as.post(s.orders, { items: [drinkItem(s), burgerItem(s)] }), 201);
        const toggle = round % 2 === 0 ? s.api.post(`/kitchen-sectors/${s.bar.id}/deactivate`) : client(s.actors.manager).put(`${s.branchSectors}/${s.bar.id}`, { enabled: false });
        const [confirmed, changed] = await Promise.all([as.post(`${s.orders}/${draft.id}/confirm`, { payments: [{ method: "PIX", amount: draft.total }] }), toggle]);
        expect([confirmed.status, changed.status], `round ${round}`).toEqual([200, 200]);
        const codes = (confirmed.body as OrderDto).kitchenTickets.map((t) => t.sector.code).sort();
        expect([["BAR", "COZINHA"], ["COZINHA"]]).toContainEqual(codes);
      }
    });
  });
});
