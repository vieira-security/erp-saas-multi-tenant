import { randomUUID } from "node:crypto";
import type { CashSessionDto, CashSessionSummaryDto, OrderDto, Page, ProductDto } from "@erp/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { BranchStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { CLOCK, type Clock } from "../../src/clock/clock.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

type Role = "OWNER" | "MANAGER" | "ATTENDANT" | "KITCHEN";
type Res = { status: number; body: unknown };
const NOT_FOUND = { status: 404, body: { error: "not_found" } };
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const conflict = (error: string) => ({ status: 409, body: { error } });

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

// M6 over real HTTP: cash sessions, payments on confirmation, refunds on cancellation. Runtime identity erp_app.
describe("M6 cash and payments over HTTP (PostgreSQL, as erp_app)", () => {
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
      actor,
      get: (path: string) => http.request(path, { token }),
      post: (path: string, body?: unknown) => http.request(path, { method: "POST", token, ...(body !== undefined ? { body } : {}) }),
      put: (path: string, body: unknown) => http.request(path, { method: "PUT", token, body }),
    };
  }
  type Client = ReturnType<typeof client>;

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
    const burger = await product({ name: "X-Burger", basePrice: "32.50" });
    const juice = await product({ name: "Suco", basePrice: "5.00" });
    const water = await product({ name: "Água grátis", basePrice: "0" });
    const cash = (branchId: string) => `/branches/${branchId}/cash-sessions`;
    return {
      org,
      actors,
      api,
      burger,
      juice,
      water,
      main: `/branches/${org.branchId}/orders`,
      other: `/branches/${org.otherBranchId}/orders`,
      cashMain: cash(org.branchId),
      cashOther: cash(org.otherBranchId),
    };
  }
  type Shop = Awaited<ReturnType<typeof shop>>;

  async function open(as: Client, base: string, openingAmount = "100.00"): Promise<CashSessionDto> {
    const res = await as.post(base, { openingAmount });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as CashSessionDto;
  }

  async function draft(s: Shop, as: Client, productId: string, quantity = 1, base = s.main): Promise<OrderDto> {
    const res = await as.post(base, { items: [{ productId, quantity }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as OrderDto;
  }

  const confirm = (as: Client, base: string, orderId: string, payments: unknown[]) => as.post(`${base}/${orderId}/confirm`, { payments });
  const pix = (amount: string, reference?: string) => ({ method: "PIX", amount, ...(reference ? { reference } : {}) });
  const cashPay = (amount: string, receivedAmount: string) => ({ method: "CASH", amount, receivedAmount });

  async function paidOrder(s: Shop, as: Client, payments: unknown[], productId = s.burger.id, quantity = 1): Promise<OrderDto> {
    const order = await draft(s, as, productId, quantity);
    const res = await confirm(as, s.main, order.id, payments);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as OrderDto;
  }

  const session = async (as: Client, base: string, id: string) => (await as.get(`${base}/${id}`)).body as CashSessionDto;

  describe("authentication and authorization", () => {
    it("requires a token on every cash route", async () => {
      const base = `/branches/${randomUUID()}/cash-sessions`;
      const id = randomUUID();
      for (const [method, path] of [["POST", base], ["GET", base], ["GET", `${base}/current`], ["GET", `${base}/${id}`], ["POST", `${base}/${id}/movements`], ["POST", `${base}/${id}/close`]] as const) {
        expect(await http.request(path, { method }), `${method} ${path}`).toEqual({ status: 401, body: { error: "unauthenticated" } });
      }
    });

    it("KITCHEN, a user without role and a user without branch access get 403 everywhere", async () => {
      const s = await shop("Caixa 403");
      const managerSession = await open(client(s.actors.manager), s.cashMain);
      const attendantOther = client(s.actors.attendant); // MAIN only
      const routes = (base: string, id: string): [string, string, unknown?][] => [
        ["POST", base, { openingAmount: "0" }],
        ["GET", base],
        ["GET", `${base}/current`],
        ["GET", `${base}/${id}`],
        ["POST", `${base}/${id}/movements`, { type: "SUPPLY", amount: "1", reason: "troco" }],
        ["POST", `${base}/${id}/close`, { countedCash: "0" }],
      ];
      for (const who of [s.actors.kitchen, s.actors.nobody]) {
        for (const [method, path, body] of routes(s.cashMain, managerSession.id)) {
          expect(await http.request(path, { method, token: who.token, ...(body !== undefined ? { body } : {}) }), `${method} ${path}`).toEqual(FORBIDDEN);
        }
      }
      for (const [method, path, body] of routes(s.cashOther, managerSession.id)) {
        expect(await http.request(path, { method, token: attendantOther.actor.token, ...(body !== undefined ? { body } : {}) }), `${method} ${path}`).toEqual(FORBIDDEN);
      }
    });

    it("ATTENDANT runs its own cash session but cannot see, move or close someone else's; MANAGER does everything", async () => {
      const s = await shop("Caixa papéis");
      const attendant = client(s.actors.attendant);
      const manager = client(s.actors.manager);
      const mine = await open(attendant, s.cashMain, "50.00");
      const theirs = await open(client(s.actors.attendant2), s.cashMain, "20.00");
      expect((await attendant.get(`${s.cashMain}/current`)).body).toMatchObject({ id: mine.id, status: "OPEN", openingAmount: "50.00", expectedCash: "50.00" });
      expect(((await attendant.get(s.cashMain)).body as Page<CashSessionSummaryDto>).items.map((x) => x.id)).toEqual([mine.id]);
      expect(await attendant.get(`${s.cashMain}/${theirs.id}`)).toEqual(NOT_FOUND);
      expect(await attendant.post(`${s.cashMain}/${theirs.id}/close`, { countedCash: "20.00" })).toEqual(FORBIDDEN);
      expect(await attendant.post(`${s.cashMain}/${mine.id}/movements`, { type: "WITHDRAWAL", amount: "1.00", reason: "sangria" })).toEqual(FORBIDDEN);
      expect(await attendant.post(`${s.cashMain}/${mine.id}/movements`, { type: "SUPPLY", amount: "1.00", reason: "troco" })).toEqual(FORBIDDEN);
      expect((await attendant.post(`${s.cashMain}/${mine.id}/close`, { countedCash: "50.00" })).status).toBe(200);

      expect(((await manager.get(s.cashMain)).body as Page<CashSessionSummaryDto>).items.map((x) => x.id).sort()).toEqual([mine.id, theirs.id].sort());
      expect((await manager.get(`${s.cashMain}/${theirs.id}`)).status).toBe(200);
      expect((await manager.post(`${s.cashMain}/${theirs.id}/movements`, { type: "SUPPLY", amount: "10.00", reason: "reforço de troco" })).status).toBe(201);
      const closed = await manager.post(`${s.cashMain}/${theirs.id}/close`, { countedCash: "30.00" });
      expect(closed).toMatchObject({ status: 200, body: { status: "CLOSED", closedBy: { userId: s.actors.manager.userId }, expectedCash: "30.00", countedCash: "30.00", difference: "0.00" } });
    });
  });

  describe("cash sessions", () => {
    it("one OPEN session per operator and branch; operators run sessions in parallel; another branch is independent", async () => {
      const s = await shop("Um caixa");
      const manager = client(s.actors.manager);
      const first = await open(manager, s.cashMain);
      expect(Object.keys(first).sort()).toEqual(
        ["branchId", "closedAt", "closedBy", "countedCash", "difference", "expectedCash", "id", "justification", "movements", "openedAt", "openedBy", "openingAmount", "status", "totals"],
      );
      expect(first).toMatchObject({ openedBy: { userId: s.actors.manager.userId, name: s.actors.manager.name }, totals: [{ method: "CASH", net: "0.00" }, { method: "PIX", net: "0.00" }, { method: "DEBIT_CARD", net: "0.00" }, { method: "CREDIT_CARD", net: "0.00" }] });
      expect(await manager.post(s.cashMain, { openingAmount: "0" })).toEqual(conflict("cash_session_already_open"));
      expect((await manager.post(s.cashOther, { openingAmount: "0" })).status).toBe(201);
      expect((await client(s.actors.owner).post(s.cashMain, { openingAmount: "0" })).status).toBe(201);
      await manager.post(`${s.cashMain}/${first.id}/close`, { countedCash: "100.00" });
      expect((await manager.post(s.cashMain, { openingAmount: "0" })).status).toBe(201);
    });

    it("validates the body; inactive branch cannot open; no current session = 404", async () => {
      const s = await shop("Caixa validação");
      const manager = client(s.actors.manager);
      expect(await manager.get(`${s.cashMain}/current`)).toEqual(NOT_FOUND);
      expect(await manager.post(s.cashMain, { openingAmount: 10, tenantId: s.org.tenantId })).toEqual({
        status: 400,
        body: { error: "validation_failed", details: [{ field: "tenantId", issue: "unknown_field" }, { field: "openingAmount", issue: "invalid_money" }] },
      });
      expect((await manager.post(s.cashMain, { openingAmount: "-1" })).body).toEqual({ error: "validation_failed", details: [{ field: "openingAmount", issue: "invalid_money" }] });
      await owner.branch.update({ where: { id: s.org.branchId }, data: { status: BranchStatus.INACTIVE } });
      expect(await manager.post(s.cashMain, { openingAmount: "0" })).toEqual(conflict("branch_inactive"));
    });

    it("supply/withdrawal: withdrawal above expected cash = 409, closed session = 409, validation with fields", async () => {
      const s = await shop("Movimentos");
      const manager = client(s.actors.manager);
      const cs = await open(manager, s.cashMain, "50.00");
      const path = `${s.cashMain}/${cs.id}/movements`;
      expect(await manager.post(path, { type: "WITHDRAWAL", amount: "50.01", reason: "sangria" })).toEqual(conflict("insufficient_cash"));
      const supply = await manager.post(path, { type: "SUPPLY", amount: "25.00", reason: "  reforço  " });
      expect(supply).toMatchObject({ status: 201, body: { expectedCash: "75.00", movements: [{ type: "SUPPLY", amount: "25.00", reason: "reforço", createdBy: { userId: s.actors.manager.userId } }] } });
      expect((await manager.post(path, { type: "WITHDRAWAL", amount: "75.00", reason: "sangria total" })).body).toMatchObject({ expectedCash: "0.00" });
      expect((await manager.post(path, { type: "LOAN", amount: "0", reason: "x" })).body).toEqual({
        error: "validation_failed",
        details: [{ field: "type", issue: "invalid_value" }, { field: "amount", issue: "invalid_value" }, { field: "reason", issue: "too_short" }],
      });
      await manager.post(`${s.cashMain}/${cs.id}/close`, { countedCash: "0.00" });
      expect(await manager.post(path, { type: "SUPPLY", amount: "1.00", reason: "troco" })).toEqual(conflict("cash_session_closed"));
    });

    it("closing: difference needs a justification; it is stored with sign; a closed session never closes again", async () => {
      const s = await shop("Fechamento");
      const attendant = client(s.actors.attendant);
      const cs = await open(attendant, s.cashMain, "100.00");
      const path = `${s.cashMain}/${cs.id}/close`;
      expect(await attendant.post(path, { countedCash: "95.00" })).toEqual({ status: 400, body: { error: "validation_failed", details: [{ field: "justification", issue: "required" }] } });
      expect((await attendant.post(path, { countedCash: "95.00", justification: "ab" })).body).toEqual({ error: "validation_failed", details: [{ field: "justification", issue: "too_short" }] });
      clock.fixed = new Date("2026-11-10T22:00:00.000Z");
      const res = await attendant.post(path, { countedCash: "95.00", justification: "  faltou troco  " });
      expect(res).toMatchObject({
        status: 200,
        body: { status: "CLOSED", expectedCash: "100.00", countedCash: "95.00", difference: "-5.00", justification: "faltou troco", closedAt: "2026-11-10T22:00:00.000Z" },
      });
      expect(await attendant.post(path, { countedCash: "100.00" })).toEqual(conflict("cash_session_closed"));
      const other = await open(attendant, s.cashMain, "10.00");
      expect((await attendant.post(`${s.cashMain}/${other.id}/close`, { countedCash: "12.00", justification: "sobrou" })).body).toMatchObject({ difference: "2.00" });
    });

    it("the expected cash of a full day matches: fund + cash sales (with change) + supply − withdrawal − cash refund", async () => {
      const s = await shop("Dia completo");
      const manager = client(s.actors.manager);
      const cs = await open(manager, s.cashMain, "100.00");
      const sale = await paidOrder(s, manager, [cashPay("32.50", "50.00")]); // change 17.50
      expect(sale).toMatchObject({ changeGiven: "17.50", payments: [{ method: "CASH", amount: "32.50", receivedAmount: "50.00", change: "17.50", cashSessionId: cs.id }] });
      await paidOrder(s, manager, [pix("5.00")], s.juice.id);
      const refunded = await paidOrder(s, manager, [cashPay("5.00", "5.00")], s.juice.id);
      await manager.post(`${s.cashMain}/${cs.id}/movements`, { type: "SUPPLY", amount: "20.00", reason: "reforço" });
      await manager.post(`${s.cashMain}/${cs.id}/movements`, { type: "WITHDRAWAL", amount: "30.00", reason: "sangria" });
      const cancelled = await manager.post(`${s.main}/${refunded.id}/cancel`, { reason: "cliente desistiu" });
      expect(cancelled).toMatchObject({ status: 200, body: { refunds: [{ method: "CASH", amount: "5.00", cashSessionId: cs.id }] } });
      const now = await session(manager, s.cashMain, cs.id);
      expect(now.expectedCash).toBe("122.50"); // 100 + 32.50 + 5.00 + 20 − 30 − 5.00
      expect(now.totals).toEqual([
        { method: "CASH", net: "32.50" },
        { method: "PIX", net: "5.00" },
        { method: "DEBIT_CARD", net: "0.00" },
        { method: "CREDIT_CARD", net: "0.00" },
      ]);
      const closed = await manager.post(`${s.cashMain}/${cs.id}/close`, { countedCash: "122.50" });
      expect(closed).toMatchObject({ status: 200, body: { expectedCash: "122.50", difference: "0.00", justification: null } });
      const [row] = await owner.$queryRaw<{ expected: string }[]>`SELECT expected_cash::text AS expected FROM cash_sessions WHERE id = ${cs.id}::uuid`;
      expect(row?.expected).toBe("122.50");
    });

    it("lists newest first with status filter and pagination", async () => {
      const s = await shop("Lista caixas");
      const manager = client(s.actors.manager);
      clock.fixed = new Date("2026-11-10T10:00:00.000Z");
      const a = await open(manager, s.cashMain, "0");
      await manager.post(`${s.cashMain}/${a.id}/close`, { countedCash: "0" });
      clock.fixed = new Date("2026-11-10T11:00:00.000Z");
      const b = await open(client(s.actors.attendant), s.cashMain, "0");
      clock.fixed = new Date("2026-11-10T12:00:00.000Z");
      const c = await open(manager, s.cashMain, "0");
      const ids = async (q: string) => ((await manager.get(`${s.cashMain}?${q}`)).body as Page<CashSessionSummaryDto>).items.map((x) => x.id);
      expect(await ids("pageSize=10")).toEqual([c.id, b.id, a.id]);
      expect(await ids("status=CLOSED")).toEqual([a.id]);
      expect(await ids("status=OPEN&pageSize=1&page=2")).toEqual([b.id]);
      expect((await manager.get(`${s.cashMain}?status=DONE`)).body).toEqual({ error: "validation_failed", details: [{ field: "status", issue: "invalid_value" }] });
    });

    it("a session of another branch or tenant is 404; malformed id is 404", async () => {
      const s = await shop("Caixa 404");
      const foreign = await shop("Caixa outro tenant");
      const manager = client(s.actors.manager);
      const otherBranch = await open(manager, s.cashOther);
      const foreignSession = await open(client(foreign.actors.manager), foreign.cashMain);
      for (const id of [otherBranch.id, foreignSession.id, randomUUID(), "not-a-uuid"]) {
        expect(await manager.get(`${s.cashMain}/${id}`), id).toEqual(NOT_FOUND);
        expect(await manager.post(`${s.cashMain}/${id}/movements`, { type: "SUPPLY", amount: "1", reason: "troco" })).toEqual(NOT_FOUND);
        expect(await manager.post(`${s.cashMain}/${id}/close`, { countedCash: "0" })).toEqual(NOT_FOUND);
      }
      expect((await owner.cashSession.findUniqueOrThrow({ where: { id: foreignSession.id } })).status).toBe("OPEN");
    });
  });

  describe("confirmation with payments", () => {
    it("requires an OPEN cash session of the confirmer IN THIS BRANCH; the order stays EDITING", async () => {
      const s = await shop("Sem caixa");
      const manager = client(s.actors.manager);
      const order = await draft(s, manager, s.juice.id);
      expect(await confirm(manager, s.main, order.id, [pix("5.00")])).toEqual(conflict("cash_session_required"));
      await open(manager, s.cashOther); // a session in ANOTHER branch never receives this payment
      expect(await confirm(manager, s.main, order.id, [pix("5.00")])).toEqual(conflict("cash_session_required"));
      const closedHere = await open(manager, s.cashMain);
      await manager.post(`${s.cashMain}/${closedHere.id}/close`, { countedCash: "100.00" });
      expect(await confirm(manager, s.main, order.id, [pix("5.00")])).toEqual(conflict("cash_session_required"));
      expect(await owner.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "EDITING", number: null });
      expect(await owner.payment.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("rejects a sum different from the total (409, nothing financial recorded) and validates the payment list with paths", async () => {
      const s = await shop("Soma");
      const attendant = client(s.actors.attendant);
      await open(attendant, s.cashMain);
      const order = await draft(s, attendant, s.juice.id, 2); // 10.00
      expect(await confirm(attendant, s.main, order.id, [pix("9.99")])).toEqual(conflict("payment_total_mismatch"));
      expect(await confirm(attendant, s.main, order.id, [pix("5.00"), pix("5.01")])).toEqual(conflict("payment_total_mismatch"));
      expect(await confirm(attendant, s.main, order.id, [])).toEqual(conflict("payment_total_mismatch"));
      expect(await attendant.post(`${s.main}/${order.id}/confirm`, {})).toEqual({ status: 400, body: { error: "validation_failed", details: [{ field: "payments", issue: "required" }] } });
      expect((await confirm(attendant, s.main, order.id, [{ method: "CASH", amount: "10.00" }, { method: "PIX", amount: "1.00", receivedAmount: "1.00" }])).body).toEqual({
        error: "validation_failed",
        details: [{ field: "payments[0].receivedAmount", issue: "required" }, { field: "payments[1].receivedAmount", issue: "invalid_value" }],
      });
      expect(await owner.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "EDITING", number: null });
      expect(await owner.payment.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("split, change, references; payments land in the confirmer's session", async () => {
      const s = await shop("Split");
      const attendant = client(s.actors.attendant);
      const cs = await open(attendant, s.cashMain);
      const order = await draft(s, attendant, s.burger.id, 2); // 65.00
      const res = await confirm(attendant, s.main, order.id, [cashPay("20.00", "50.00"), pix("30.00", "E2E-123"), { method: "DEBIT_CARD", amount: "10.00" }, { method: "CREDIT_CARD", amount: "5.00", reference: "NSU 9" }]);
      expect(res.status).toBe(200);
      const body = res.body as OrderDto;
      expect(body).toMatchObject({ status: "CONFIRMED", total: "65.00", changeGiven: "30.00", refunds: [] });
      expect([...body.payments].sort((a, b) => a.method.localeCompare(b.method, "en"))).toEqual([
        { id: expect.any(String), method: "CASH", amount: "20.00", receivedAmount: "50.00", change: "30.00", reference: null, cashSessionId: cs.id, createdAt: expect.any(String) },
        { id: expect.any(String), method: "CREDIT_CARD", amount: "5.00", receivedAmount: null, change: "0.00", reference: "NSU 9", cashSessionId: cs.id, createdAt: expect.any(String) },
        { id: expect.any(String), method: "DEBIT_CARD", amount: "10.00", receivedAmount: null, change: "0.00", reference: null, cashSessionId: cs.id, createdAt: expect.any(String) },
        { id: expect.any(String), method: "PIX", amount: "30.00", receivedAmount: null, change: "0.00", reference: "E2E-123", cashSessionId: cs.id, createdAt: expect.any(String) },
      ]);
      expect((await session(attendant, s.cashMain, cs.id)).expectedCash).toBe("120.00");
      expect((await attendant.get(`${s.main}/${order.id}`)).body).toEqual(body);
    });

    it("a 0.00 order confirms with an empty list", async () => {
      const s = await shop("Grátis");
      const attendant = client(s.actors.attendant);
      await open(attendant, s.cashMain);
      const order = await draft(s, attendant, s.water.id);
      expect(await confirm(attendant, s.main, order.id, [])).toMatchObject({ status: 200, body: { status: "CONFIRMED", total: "0.00", payments: [] } });
    });

    it("price changed after the draft: paying the old total is 409 and GET shows the new total to pay", async () => {
      const s = await shop("Preço mudou");
      const attendant = client(s.actors.attendant);
      await open(attendant, s.cashMain);
      const order = await draft(s, attendant, s.juice.id, 2);
      expect(order.total).toBe("10.00");
      await s.api.put(`/branches/${s.org.branchId}/product-settings/${s.juice.id}`, { available: true, price: "6.00" });
      expect(await confirm(attendant, s.main, order.id, [pix("10.00")])).toEqual(conflict("payment_total_mismatch"));
      const refreshed = (await attendant.get(`${s.main}/${order.id}`)).body as OrderDto;
      expect(refreshed).toMatchObject({ status: "EDITING", number: null, total: "12.00", payments: [] });
      expect(await confirm(attendant, s.main, order.id, [pix(refreshed.total)])).toMatchObject({ status: 200, body: { total: "12.00" } });
    });
  });

  describe("cancellation with refunds", () => {
    it("a draft has nothing to refund", async () => {
      const s = await shop("Rascunho sem estorno");
      const attendant = client(s.actors.attendant);
      const order = await draft(s, attendant, s.juice.id);
      expect(await attendant.post(`${s.main}/${order.id}/cancel`)).toMatchObject({ status: 200, body: { status: "CANCELLED", refunds: [], payments: [] } });
    });

    it("refunds a paid order in every state, DELIVERED included; PIX/card refunds need no cash session", async () => {
      const s = await shop("Estorno estados");
      const attendant = client(s.actors.attendant);
      const owner_ = client(s.actors.owner); // has no cash session: card/PIX refunds only
      await open(attendant, s.cashMain);
      for (const steps of [[], ["start"], ["start", "ready"], ["start", "ready", "deliver"]]) {
        const order = await paidOrder(s, attendant, [pix("20.00"), { method: "CREDIT_CARD", amount: "12.50" }]);
        for (const step of steps) expect((await attendant.post(`${s.main}/${order.id}/${step}`)).status).toBe(200);
        clock.fixed = new Date("2026-11-10T20:00:00.000Z");
        const res = await owner_.post(`${s.main}/${order.id}/cancel`, { reason: "estorno na maquininha" });
        clock.fixed = null;
        expect(res.status, `${steps.join(">")}: ${JSON.stringify(res.body)}`).toBe(200);
        const body = res.body as OrderDto;
        expect(body.status).toBe("CANCELLED");
        expect(body.refunds.map((r) => [r.method, r.amount, r.cashSessionId]).sort()).toEqual([["CREDIT_CARD", "12.50", null], ["PIX", "20.00", null]]);
        expect(body.refunds.map((r) => r.paymentId).sort()).toEqual(body.payments.map((p) => p.id).sort());
      }
    });

    it("a cash refund comes out of the canceller's OPEN session; without one it is 409 and nothing changes", async () => {
      const s = await shop("Estorno dinheiro");
      const attendant = client(s.actors.attendant);
      const manager = client(s.actors.manager);
      const attendantSession = await open(attendant, s.cashMain);
      const order = await paidOrder(s, attendant, [cashPay("32.50", "40.00")]);
      for (const step of ["start", "ready", "deliver"]) await attendant.post(`${s.main}/${order.id}/${step}`);
      expect(await manager.post(`${s.main}/${order.id}/cancel`, { reason: "devolução" })).toEqual(conflict("cash_session_required"));
      expect(await owner.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "DELIVERED", cancelledAt: null });
      expect(await owner.refund.count({ where: { orderId: order.id } })).toBe(0);
      const managerSession = await open(manager, s.cashMain, "50.00");
      const res = await manager.post(`${s.main}/${order.id}/cancel`, { reason: "devolução" });
      expect(res).toMatchObject({ status: 200, body: { status: "CANCELLED", refunds: [{ method: "CASH", amount: "32.50", cashSessionId: managerSession.id }] } });
      expect((await session(manager, s.cashMain, managerSession.id)).expectedCash).toBe("17.50"); // 50 − 32.50
      expect((await session(attendant, s.cashMain, attendantSession.id)).expectedCash).toBe("132.50"); // sale stays in the seller's session
    });

    // Auditoria M6: o estorno em dinheiro sai do caixa de QUEM CANCELA, não do caixa da venda. Sem esta trava o esperado
    // desse caixa ficava negativo, o GET do caixa respondia 500 e o caixa nunca mais fechava.
    it("a cash refund larger than the canceller's cash is 409 insufficient_cash and nothing changes", async () => {
      const s = await shop("Estorno sem saldo");
      const attendant = client(s.actors.attendant);
      const manager = client(s.actors.manager);
      await open(attendant, s.cashMain);
      const order = await paidOrder(s, attendant, [cashPay("32.50", "50.00")]);
      const managerSession = await open(manager, s.cashMain, "10.00");
      expect(await manager.post(`${s.main}/${order.id}/cancel`, { reason: "devolução" })).toEqual(conflict("insufficient_cash"));
      expect(await owner.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "CONFIRMED", cancelledAt: null });
      expect(await owner.refund.count({ where: { orderId: order.id } })).toBe(0);
      const after = await manager.get(`${s.cashMain}/${managerSession.id}`);
      expect(after).toMatchObject({ status: 200, body: { expectedCash: "10.00" } });
      // Com suprimento suficiente o mesmo estorno passa, e o caixa continua fechável.
      expect((await manager.post(`${s.cashMain}/${managerSession.id}/movements`, { type: "SUPPLY", amount: "22.50", reason: "troco" })).status).toBe(201);
      expect(await manager.post(`${s.main}/${order.id}/cancel`, { reason: "devolução" })).toMatchObject({ status: 200, body: { status: "CANCELLED" } });
      expect((await session(manager, s.cashMain, managerSession.id)).expectedCash).toBe("0.00");
      expect(await manager.post(`${s.cashMain}/${managerSession.id}/close`, { countedCash: "0.00" })).toMatchObject({ status: 200, body: { status: "CLOSED" } });
    });

    it("the author attendant cannot refund a paid order (403); reason required (400)", async () => {
      const s = await shop("Atendente não estorna");
      const attendant = client(s.actors.attendant);
      const manager = client(s.actors.manager);
      await open(attendant, s.cashMain);
      const order = await paidOrder(s, attendant, [pix("32.50")]);
      expect(await attendant.post(`${s.main}/${order.id}/cancel`, { reason: "desistiu" })).toEqual(FORBIDDEN);
      expect(await manager.post(`${s.main}/${order.id}/cancel`)).toEqual({ status: 400, body: { error: "validation_failed", details: [{ field: "reason", issue: "required" }] } });
      expect(await owner.refund.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("an order of another branch or tenant is 404 for refunds too", async () => {
      const s = await shop("Estorno 404");
      const foreign = await shop("Estorno outro tenant");
      const fm = client(foreign.actors.manager);
      await open(fm, foreign.cashMain);
      const foreignOrder = await paidOrder(foreign, fm, [pix("32.50")]);
      expect(await client(s.actors.manager).post(`${s.main}/${foreignOrder.id}/cancel`, { reason: "invasão" })).toEqual(NOT_FOUND);
      expect(await owner.refund.count({ where: { orderId: foreignOrder.id } })).toBe(0);
    });
  });

  describe("concurrency", () => {
    it("opening two sessions in parallel for the same operator: one 201, one 409", async () => {
      const s = await shop("Corrida abrir");
      const manager = client(s.actors.manager);
      for (let round = 0; round < 3; round++) {
        const results: Res[] = await Promise.all([manager.post(s.cashMain, { openingAmount: "0" }), manager.post(s.cashMain, { openingAmount: "0" })]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        const opened = results.find((r) => r.status === 201)!.body as CashSessionDto;
        await manager.post(`${s.cashMain}/${opened.id}/close`, { countedCash: "0" });
      }
    });

    it("confirm × close in parallel: never a payment in a closed session; the stored expected cash includes it or not, consistently", async () => {
      const s = await shop("Corrida fechar");
      const attendant = client(s.actors.attendant);
      for (let round = 0; round < 6; round++) {
        const cs = await open(attendant, s.cashMain, "10.00");
        const order = await draft(s, attendant, s.juice.id);
        const [confirmed, closed] = await Promise.all([
          confirm(attendant, s.main, order.id, [cashPay("5.00", "5.00")]),
          attendant.post(`${s.cashMain}/${cs.id}/close`, { countedCash: "10.00", justification: "conferência" }),
        ]);
        expect(closed.status, JSON.stringify(closed.body)).toBe(200);
        const stored = await owner.cashSession.findUniqueOrThrow({ where: { id: cs.id } });
        const payments = await owner.payment.findMany({ where: { cashSessionId: cs.id } });
        if (confirmed.status === 200) {
          // Confirmed first: the close waited and counted the payment.
          expect(payments).toHaveLength(1);
          expect(stored.expectedCash?.toFixed(2)).toBe("15.00");
        } else {
          expect(confirmed).toEqual(conflict("cash_session_required"));
          expect(payments).toHaveLength(0);
          expect(stored.expectedCash?.toFixed(2)).toBe("10.00");
        }
      }
    });

    it("two parallel withdrawals that together exceed the cash: one 201, one 409", async () => {
      const s = await shop("Corrida sangria");
      const manager = client(s.actors.manager);
      for (let round = 0; round < 3; round++) {
        const cs = await open(manager, s.cashMain, "100.00");
        const path = `${s.cashMain}/${cs.id}/movements`;
        const results = await Promise.all([
          manager.post(path, { type: "WITHDRAWAL", amount: "60.00", reason: "sangria A" }),
          manager.post(path, { type: "WITHDRAWAL", amount: "60.00", reason: "sangria B" }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body).toEqual({ error: "insufficient_cash" });
        expect((await session(manager, s.cashMain, cs.id)).expectedCash).toBe("40.00");
        await manager.post(`${s.cashMain}/${cs.id}/close`, { countedCash: "40.00" });
      }
    });

    it("cancel × confirm of the same paid-in-cash order ends coherent (refund only if it was confirmed)", async () => {
      const s = await shop("Corrida cancelar pago");
      const manager = client(s.actors.manager);
      const cs = await open(manager, s.cashMain, "100.00");
      for (let round = 0; round < 5; round++) {
        const order = await draft(s, manager, s.juice.id);
        const [confirmed, cancelled] = await Promise.all([confirm(manager, s.main, order.id, [cashPay("5.00", "10.00")]), manager.post(`${s.main}/${order.id}/cancel`, { reason: "desistiu" })]);
        expect(cancelled.status).toBe(200);
        const refunds = await owner.refund.count({ where: { orderId: order.id } });
        expect(refunds).toBe(confirmed.status === 200 ? 1 : 0);
      }
      // Every confirmed-then-refunded sale nets to zero in the session.
      expect((await session(manager, s.cashMain, cs.id)).expectedCash).toBe("100.00");
    });
  });
});
