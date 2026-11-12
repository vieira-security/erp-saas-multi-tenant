import { randomUUID } from "node:crypto";
import type {
  AuditLogDto,
  BranchDto,
  CashSessionDto,
  CompanyDto,
  KitchenSectorDto,
  KitchenTicketDto,
  OrderDto,
  Page,
  ProductCategoryDto,
  ProductDto,
  UserDto,
} from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { DEFAULT_PASSWORD, authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

type Role = "OWNER" | "MANAGER" | "ATTENDANT" | "KITCHEN";
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const ITEM_KEYS = ["action", "actor", "branch", "createdAt", "id", "metadata", "resourceId", "resourceType"];

interface Actor {
  readonly userId: string;
  readonly token: string;
  readonly refreshToken: string;
}

// KAN-41 over real HTTP: every audited action goes through the API (AppModule, guards, erp_app) and is read back with
// GET /audit-logs. Each describe uses its own tenant, so counts are exact even with the other files running in parallel.
describe("KAN-41 audit history over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config);
    await ensurePermissionCatalog(owner);
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
    const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: DEFAULT_PASSWORD });
    return { userId: user.id, token: tokens.accessToken, refreshToken: tokens.refreshToken };
  }

  function client(actor: Actor) {
    const token = actor.token;
    return {
      get: (path: string) => http.request(path, { token }),
      post: (path: string, body?: unknown) => http.request(path, { method: "POST", token, ...(body !== undefined ? { body } : {}) }),
      put: (path: string, body?: unknown) => http.request(path, { method: "PUT", token, ...(body !== undefined ? { body } : {}) }),
      patch: (path: string, body: unknown) => http.request(path, { method: "PATCH", token, body }),
      delete: (path: string) => http.request(path, { method: "DELETE", token }),
    };
  }

  async function ok<T>(promise: Promise<{ status: number; body: unknown }>, status = 200): Promise<T> {
    const res = await promise;
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as T;
  }

  /** Tenant with default roles + default sector, MAIN and OTHER; owner (both branches) and manager (MAIN only). */
  async function shop(name: string) {
    const org = await seedOrg(owner, name);
    await h.tenants.run({ tenantId: org.tenantId }, async () => {
      const provisioning = new TenantProvisioningService(prisma, h.scope);
      await provisioning.provisionDefaultRoles();
      await provisioning.provisionDefaultKitchenSector();
    });
    const actors = {
      owner: await login(org, "OWNER", [org.branchId, org.otherBranchId]),
      manager: await login(org, "MANAGER", [org.branchId]),
      attendant: await login(org, "ATTENDANT", [org.branchId]),
      kitchen: await login(org, "KITCHEN", [org.branchId]),
    };
    return { org, actors, api: client(actors.owner) };
  }

  const list = (actor: Actor, query: Record<string, string> = {}) => client(actor).get(`/audit-logs?${new URLSearchParams(query).toString()}`);

  /** The single event matching the query, read through the API as `actor`. */
  async function single(actor: Actor, query: Record<string, string>): Promise<AuditLogDto> {
    const page = await ok<Page<AuditLogDto>>(list(actor, query));
    expect(page.total, JSON.stringify(page.items.map((i) => i.action))).toBe(1);
    expect(Object.keys(page.items[0]!).sort()).toEqual(ITEM_KEYS);
    return page.items[0]!;
  }

  const count = (org: Org, where: Prisma.AuditLogWhereInput = {}) => owner.auditLog.count({ where: { tenantId: org.tenantId, ...where } });
  const actorOf = async (org: Org, actor: Actor) => ({ userId: actor.userId, name: (await owner.user.findUniqueOrThrow({ where: { id: actor.userId } })).name });
  const branchOf = async (branchId: string) => {
    const b = await owner.branch.findUniqueOrThrow({ where: { id: branchId } });
    return { id: b.id, name: b.name, code: b.code };
  };

  describe("organization: organization, company, branch and branch access", () => {
    it("audits each change once, with the actor, the branch (for branch events) and only the changed fields", async () => {
      const { org, actors, api } = await shop("Audit Org");
      const actor = await actorOf(org, actors.owner);

      await ok(api.patch("/organization", { name: "Audit Org 2" }));
      await ok(api.patch("/organization", { name: "Audit Org 2" })); // same name: no event
      expect(await single(actors.owner, { action: "organization.updated" })).toMatchObject({
        resourceType: "organization",
        resourceId: org.tenantId,
        branch: null,
        actor,
        metadata: { changes: { name: { from: "Audit Org", to: "Audit Org 2" } } },
      });

      const company = await ok<CompanyDto>(api.post("/companies", { legalName: "Filial Dois Ltda", tradeName: "Dois", cnpj: "11.444.777/0001-61", timezone: "America/Sao_Paulo" }), 201);
      expect(await single(actors.owner, { action: "company.created", resourceId: company.id })).toMatchObject({
        resourceType: "company",
        branch: null,
        actor,
        metadata: { legalName: "Filial Dois Ltda", tradeName: "Dois", cnpj: "11444777000161", timezone: "America/Sao_Paulo" },
      });
      await ok(api.patch(`/companies/${company.id}`, { tradeName: "Dois Novo", legalName: "Filial Dois Ltda" }));
      expect((await single(actors.owner, { action: "company.updated", resourceId: company.id })).metadata).toEqual({
        changes: { tradeName: { from: "Dois", to: "Dois Novo" } },
      });
      await ok(api.post(`/companies/${company.id}/deactivate`));
      await ok(api.post(`/companies/${company.id}/deactivate`)); // idempotent: no event
      await ok(api.post(`/companies/${company.id}/activate`));
      await ok(api.post(`/companies/${company.id}/activate`));
      expect(await count(org, { resourceId: company.id, action: { in: ["company.deactivated", "company.activated"] } })).toBe(2);
      expect((await single(actors.owner, { action: "company.deactivated" })).metadata).toBeNull();

      // Branch events carry the branch itself: visible to who has audit.read THERE.
      const branch = await ok<BranchDto>(api.post("/branches", { companyId: org.companyId, name: "Nova", code: "nova" }), 201);
      await ok(api.patch(`/branches/${branch.id}`, { name: "Nova Loja", code: "NOVA" }));
      await ok(api.post(`/branches/${branch.id}/deactivate`));
      await ok(api.post(`/branches/${branch.id}/deactivate`));
      await ok(api.post(`/branches/${branch.id}/activate`));
      const branchEvents = await owner.auditLog.findMany({ where: { tenantId: org.tenantId, resourceId: branch.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      expect(branchEvents.map((e) => [e.action, e.branchId, e.userId])).toEqual([
        ["branch.created", branch.id, actors.owner.userId],
        ["branch.updated", branch.id, actors.owner.userId],
        ["branch.deactivated", branch.id, actors.owner.userId],
        ["branch.activated", branch.id, actors.owner.userId],
      ]);
      expect(branchEvents[0]!.metadata).toEqual({ companyId: org.companyId, name: "Nova", code: "NOVA", cnpj: null, timezone: "America/Sao_Paulo" });
      expect(branchEvents[1]!.metadata).toEqual({ changes: { name: { from: "Nova", to: "Nova Loja" } } });
      // The owner has no access to the new branch yet, but sees its events anyway (decision: the owner sees everything).
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { resourceId: branch.id }))).total).toBe(4);

      // Branch access: granted/revoked in the branch, target in resource_id; repeating a grant does not audit.
      const target = await seedUser(owner, org.tenantId);
      await ok(api.put(`/users/${target.id}/branch-access/${org.otherBranchId}`), 201);
      await ok(api.put(`/users/${target.id}/branch-access/${org.otherBranchId}`), 200);
      await ok(api.delete(`/users/${target.id}/branch-access/${org.otherBranchId}`), 204);
      const granted = await single(actors.owner, { action: "branch_access.granted" });
      expect(granted).toMatchObject({ resourceType: "user", resourceId: target.id, branch: await branchOf(org.otherBranchId), actor, metadata: { targetUserId: target.id } });
      expect(await single(actors.owner, { action: "branch_access.revoked" })).toMatchObject({ resourceId: target.id, branch: { id: org.otherBranchId } });
    });
  });

  describe("menu: categories, products, option groups and branch settings", () => {
    it("records product.updated with only basePrice { from: '25.00', to: '27.00' } and skips no-op changes", async () => {
      const { org, actors, api } = await shop("Audit Menu");
      const actor = await actorOf(org, actors.owner);

      const category = await ok<ProductCategoryDto>(api.post("/product-categories", { name: "Lanches" }), 201);
      await ok(api.patch(`/product-categories/${category.id}`, { name: "Lanches", sortOrder: 3 }));
      await ok(api.patch(`/product-categories/${category.id}`, { sortOrder: 3 })); // no change
      await ok(api.post(`/product-categories/${category.id}/deactivate`));
      await ok(api.post(`/product-categories/${category.id}/activate`));
      await ok(api.post(`/product-categories/${category.id}/activate`));
      expect((await owner.auditLog.findMany({ where: { tenantId: org.tenantId, resourceId: category.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => [e.action, e.metadata])).toEqual([
        ["product_category.created", { name: "Lanches", sortOrder: 0 }],
        ["product_category.updated", { changes: { sortOrder: { from: 0, to: 3 } } }],
        ["product_category.deactivated", null],
        ["product_category.activated", null],
      ]);

      const product = await ok<ProductDto>(
        api.post("/products", {
          name: "X-Burger",
          code: "xb",
          basePrice: "25",
          categoryId: category.id,
          optionGroups: [{ name: "Tamanho", minChoices: 1, maxChoices: 1, options: [{ name: "P" }, { name: "G", priceDelta: "4.00" }] }],
        }),
        201,
      );
      expect(await single(actors.owner, { action: "product.created", resourceId: product.id })).toMatchObject({
        resourceType: "product",
        branch: null,
        actor,
        metadata: { name: "X-Burger", code: "XB", categoryId: category.id, kitchenSectorId: null, basePrice: "25.00", sortOrder: 0, optionGroups: { groups: 1, options: 2 } },
      });

      await ok(api.patch(`/products/${product.id}`, { name: "X-Burger", basePrice: "27.00", code: "XB" }));
      await ok(api.patch(`/products/${product.id}`, { basePrice: "27" })); // same price: no event
      await ok(api.patch(`/products/${product.id}`, {})); // empty PATCH: no event
      expect((await single(actors.owner, { action: "product.updated", resourceId: product.id })).metadata).toEqual({
        changes: { basePrice: { from: "25.00", to: "27.00" } },
      });

      await ok(api.put(`/products/${product.id}/option-groups`, { optionGroups: [] }));
      expect((await single(actors.owner, { action: "product.option_groups_replaced" })).metadata).toEqual({
        before: { groups: 1, options: 2 },
        after: { groups: 0, options: 0 },
      });
      await ok(api.post(`/products/${product.id}/deactivate`));
      await ok(api.post(`/products/${product.id}/deactivate`));
      await ok(api.post(`/products/${product.id}/activate`));
      expect(await count(org, { resourceId: product.id, action: { in: ["product.deactivated", "product.activated"] } })).toBe(2);

      // Branch setting: event of the branch, resource = the product; same PUT twice = one event; reset = back to default.
      await ok(api.put(`/branches/${org.branchId}/product-settings/${product.id}`, { available: true, price: "30.00" }));
      await ok(api.put(`/branches/${org.branchId}/product-settings/${product.id}`, { available: true, price: "30" }));
      await ok(api.put(`/branches/${org.branchId}/product-settings/${product.id}`, { available: false, price: "30.00" }));
      await ok(api.delete(`/branches/${org.branchId}/product-settings/${product.id}`), 204);
      await ok(api.delete(`/branches/${org.branchId}/product-settings/${product.id}`), 204);
      const settings = await ok<Page<AuditLogDto>>(list(actors.owner, { action: "branch_product_setting.updated", resourceId: product.id }));
      expect(settings.items.map((e) => e.metadata)).toEqual([
        { changes: { available: { from: false, to: true }, price: { from: "30.00", to: null } } },
        { changes: { available: { from: true, to: false } } },
        { changes: { price: { from: null, to: "30.00" } } },
      ]);
      for (const e of settings.items) expect(e).toMatchObject({ resourceType: "product", branch: await branchOf(org.branchId), actor });

      // History of the product: everything about it, most recent first.
      const history = await ok<Page<AuditLogDto>>(list(actors.owner, { resourceType: "product", resourceId: product.id }));
      expect(history.items.map((e) => e.action)).toEqual([
        "branch_product_setting.updated",
        "branch_product_setting.updated",
        "branch_product_setting.updated",
        "product.activated",
        "product.deactivated",
        "product.option_groups_replaced",
        "product.updated",
        "product.created",
      ]);
    });
  });

  describe("money: cash session, withdrawal/supply and cancellation with refund", () => {
    it("audits opening, movements, cancellations (paid and draft) and closing; a failed withdrawal leaves no event", async () => {
      const { org, actors, api } = await shop("Audit Cash");
      const b = `/branches/${org.branchId}`;
      const product = await ok<ProductDto>(api.post("/products", { name: "Suco", basePrice: "25.00" }), 201);

      const session = await ok<CashSessionDto>(api.post(`${b}/cash-sessions`, { openingAmount: "100" }), 201);
      expect(await single(actors.owner, { action: "cash_session.opened" })).toMatchObject({
        resourceType: "cash_session",
        resourceId: session.id,
        branch: await branchOf(org.branchId),
        metadata: { openingAmount: "100.00" },
      });

      await ok(api.post(`${b}/cash-sessions/${session.id}/movements`, { type: "SUPPLY", amount: "20", reason: "Troco extra" }), 201);
      // Atomicity: 409 insufficient_cash rolls back, nothing audited.
      const refused = await api.post(`${b}/cash-sessions/${session.id}/movements`, { type: "WITHDRAWAL", amount: "500.00", reason: "Cofre" });
      expect(refused).toEqual({ status: 409, body: { error: "insufficient_cash" } });
      expect(await count(org, { action: "cash_movement.withdrawal" })).toBe(0);
      await ok(api.post(`${b}/cash-sessions/${session.id}/movements`, { type: "WITHDRAWAL", amount: "50.00", reason: "Cofre" }), 201);
      const withdrawal = await single(actors.owner, { action: "cash_movement.withdrawal" });
      expect(withdrawal).toMatchObject({ resourceType: "cash_movement", metadata: { amount: "50.00", reason: "Cofre", cashSessionId: session.id } });
      expect((await single(actors.owner, { action: "cash_movement.supply" })).metadata).toEqual({ amount: "20.00", reason: "Troco extra", cashSessionId: session.id });

      // Paid order cancelled: number, previous status, reason and the refunds.
      const order = await ok<OrderDto>(api.post(`${b}/orders`, { items: [{ productId: product.id, quantity: 1 }] }), 201);
      const confirmed = await ok<OrderDto>(api.post(`${b}/orders/${order.id}/confirm`, { payments: [{ method: "CASH", amount: "25.00", receivedAmount: "30.00" }] }));
      await ok(api.post(`${b}/orders/${order.id}/cancel`, { reason: "Cliente desistiu" }));
      expect(await single(actors.owner, { action: "order.cancelled", resourceId: order.id })).toMatchObject({
        resourceType: "order",
        branch: { id: org.branchId },
        metadata: { number: confirmed.number, previousStatus: "CONFIRMED", reason: "Cliente desistiu", refunds: [{ method: "CASH", amount: "25.00" }] },
      });
      // Draft cancelled: no number, no refunds. Draft creation/confirmation/payment are never audited by themselves.
      const draft = await ok<OrderDto>(api.post(`${b}/orders`, { items: [{ productId: product.id, quantity: 2 }] }), 201);
      await ok(api.post(`${b}/orders/${draft.id}/cancel`, {}));
      expect((await single(actors.owner, { action: "order.cancelled", resourceId: draft.id })).metadata).toEqual({
        number: null,
        previousStatus: "EDITING",
        reason: null,
        refunds: [],
      });
      expect(await count(org, { resourceType: "order" })).toBe(2);

      // 100 + 20 − 50 + 25 (sale) − 25 (refund) = 70 expected; 68 counted.
      await ok(api.post(`${b}/cash-sessions/${session.id}/close`, { countedCash: "68.00", justification: "Faltou troco" }));
      expect((await single(actors.owner, { action: "cash_session.closed" })).metadata).toEqual({
        expectedCash: "70.00",
        countedCash: "68.00",
        difference: "-2.00",
        justification: "Faltou troco",
      });
    });
  });

  describe("kitchen: sectors, default, branch switch and reprint", () => {
    it("audits sector changes and only the second and later prints of a ticket", async () => {
      const { org, actors, api } = await shop("Audit Kitchen");
      const b = `/branches/${org.branchId}`;
      const [cozinha] = await ok<KitchenSectorDto[]>(api.get("/kitchen-sectors"));
      const bar = await ok<KitchenSectorDto>(api.post("/kitchen-sectors", { name: "Bar", code: "BAR" }), 201);
      await ok(api.patch(`/kitchen-sectors/${bar.id}`, { name: "Bar & Sucos", code: "BAR" }));
      await ok(api.patch(`/kitchen-sectors/${bar.id}`, { name: "Bar & Sucos" }));
      await ok(api.post(`/kitchen-sectors/${bar.id}/deactivate`));
      await ok(api.post(`/kitchen-sectors/${bar.id}/activate`));
      await ok(api.post(`/kitchen-sectors/${bar.id}/make-default`));
      await ok(api.post(`/kitchen-sectors/${bar.id}/make-default`)); // already default
      await ok(api.put(`${b}/kitchen-sectors/${cozinha!.id}`, { enabled: false }));
      await ok(api.put(`${b}/kitchen-sectors/${cozinha!.id}`, { enabled: false }));
      const sectorEvents = await owner.auditLog.findMany({ where: { tenantId: org.tenantId, resourceType: "kitchen_sector" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      expect(sectorEvents.map((e) => [e.action, e.resourceId, e.branchId, e.metadata])).toEqual([
        ["kitchen_sector.created", bar.id, null, { name: "Bar", code: "BAR", sortOrder: 0 }],
        ["kitchen_sector.updated", bar.id, null, { changes: { name: { from: "Bar", to: "Bar & Sucos" } } }],
        ["kitchen_sector.deactivated", bar.id, null, null],
        ["kitchen_sector.activated", bar.id, null, null],
        ["kitchen_sector.default_changed", bar.id, null, { fromSectorId: cozinha!.id, toSectorId: bar.id }],
        ["branch_kitchen_sector.updated", cozinha!.id, org.branchId, { changes: { enabled: { from: true, to: false } } }],
      ]);

      const product = await ok<ProductDto>(api.post("/products", { name: "Chopp", basePrice: "12.00" }), 201);
      await ok(api.post(`${b}/cash-sessions`, { openingAmount: "0" }), 201);
      const order = await ok<OrderDto>(api.post(`${b}/orders`, { items: [{ productId: product.id, quantity: 1 }] }), 201);
      await ok(api.post(`${b}/orders/${order.id}/confirm`, { payments: [{ method: "PIX", amount: "12.00" }] }));
      const tickets = await ok<Page<KitchenTicketDto>>(api.get(`${b}/kitchen-tickets`));
      const ticket = tickets.items.find((t) => t.orderId === order.id)!;
      const kitchen = client(actors.kitchen);
      await ok(kitchen.post(`${b}/kitchen-tickets/${ticket.id}/print`));
      expect(await count(org, { action: "kitchen_ticket.reprinted" })).toBe(0);
      await ok(kitchen.post(`${b}/kitchen-tickets/${ticket.id}/print`));
      await ok(kitchen.post(`${b}/kitchen-tickets/${ticket.id}/print`));
      const reprints = await ok<Page<AuditLogDto>>(list(actors.owner, { action: "kitchen_ticket.reprinted" }));
      expect(reprints.items.map((e) => e.metadata)).toEqual([
        { copyNumber: 3, orderId: order.id, sectorId: ticket.sector.id },
        { copyNumber: 2, orderId: order.id, sectorId: ticket.sector.id },
      ]);
      expect(reprints.items[0]).toMatchObject({ resourceType: "kitchen_ticket", resourceId: ticket.id, branch: { id: org.branchId }, actor: await actorOf(org, actors.kitchen) });
      // Order confirmation / payment / start / ready are never audited.
      expect(await count(org, { resourceId: order.id })).toBe(0);
    });
  });

  describe("visibility", () => {
    /**
     * Tenant with events in MAIN (manager has access), in OTHER (manager has no access) and without branch; plus a second
     * tenant with its own events.
     */
    async function mixed() {
      const s = await shop("Audit Vis");
      const p = await ok<ProductDto>(s.api.post("/products", { name: "Pão", basePrice: "5.00" }), 201); // tenant event
      for (const branchId of [s.org.branchId, s.org.otherBranchId, s.org.branchId]) {
        await ok(s.api.put(`/branches/${branchId}/product-settings/${p.id}`, { available: false, price: null }));
        await ok(s.api.delete(`/branches/${branchId}/product-settings/${p.id}`), 204);
      }
      const other = await shop("Audit Vis Other");
      await ok(other.api.post("/products", { name: "Outro", basePrice: "1.00" }), 201);
      return { ...s, other };
    }

    it("owner sees everything of the tenant (branch and tenant events); total matches the same rule", async () => {
      const { org, actors, other } = await mixed();
      const expected = await count(org, { OR: [{ branchId: { in: [org.branchId, org.otherBranchId] } }, { branchId: null }] });
      const page = await ok<Page<AuditLogDto>>(list(actors.owner, { pageSize: "3" }));
      expect(page.total).toBe(expected);
      expect(page.totalPages).toBe(Math.ceil(expected / 3));
      expect(page.items).toHaveLength(3);
      // Includes the security events (login) of the tenant, which have no branch.
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { action: "auth.login.succeeded" }))).total).toBe(4);
      // Another tenant never shows up, not even filtering by one of its users.
      const all = await ok<Page<AuditLogDto>>(list(actors.owner, { pageSize: "100" }));
      const foreign = new Set((await owner.auditLog.findMany({ where: { tenantId: other.org.tenantId }, select: { id: true } })).map((r) => r.id));
      expect(all.items.filter((i) => foreign.has(i.id))).toEqual([]);
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { userId: other.actors.owner.userId }))).total).toBe(0);
    });

    it("owner without access to a branch still sees its events (decision: the owner sees everything)", async () => {
      const { org } = await mixed();
      const ownerMainOnly = await login(org, "OWNER", [org.branchId]);
      const expected = await count(org, { branchId: org.otherBranchId });
      expect(expected).toBeGreaterThan(0);
      expect((await ok<Page<AuditLogDto>>(list(ownerMainOnly, { branchId: org.otherBranchId }))).total).toBe(expected);
      const all = await count(org, {});
      expect((await ok<Page<AuditLogDto>>(list(ownerMainOnly, { pageSize: "1" }))).total).toBe(all);
    });

    it("manager sees only the branches where he has audit.read, never tenant events; total is computed in SQL", async () => {
      const { org, actors } = await mixed();
      const expected = await count(org, { branchId: org.branchId });
      expect(expected).toBe(4);
      const first = await ok<Page<AuditLogDto>>(list(actors.manager, { pageSize: "3" }));
      const second = await ok<Page<AuditLogDto>>(list(actors.manager, { pageSize: "3", page: "2" }));
      expect(first).toMatchObject({ total: expected, totalPages: 2, page: 1, pageSize: 3 });
      expect(second.items).toHaveLength(1);
      for (const item of [...first.items, ...second.items]) expect(item.branch?.id).toBe(org.branchId);
      expect(await ok<Page<AuditLogDto>>(list(actors.manager, { action: "auth.login.succeeded,product.created" }))).toMatchObject({ total: 0, items: [] });
      expect((await ok<Page<AuditLogDto>>(list(actors.manager, { branchId: org.branchId }))).total).toBe(expected);
    });

    it("manager filtering a branch without access, attendant, kitchen and a user without role get 403", async () => {
      const { org, actors } = await mixed();
      expect(await list(actors.manager, { branchId: org.otherBranchId })).toEqual(FORBIDDEN);
      expect(await list(actors.manager, { branchId: randomUUID() })).toEqual(FORBIDDEN);
      expect(await list(actors.attendant)).toEqual(FORBIDDEN);
      expect(await list(actors.kitchen)).toEqual(FORBIDDEN);
      expect(await list(await login(org, null, [org.branchId]))).toEqual(FORBIDDEN);
      expect(await http.request("/audit-logs")).toMatchObject({ status: 401 });
    });

    it("has no write route (append-only)", async () => {
      const { actors } = await shop("Audit Ro");
      const api = client(actors.owner);
      const [event] = (await ok<Page<AuditLogDto>>(list(actors.owner))).items;
      for (const res of [await api.post("/audit-logs", {}), await api.patch(`/audit-logs/${event!.id}`, {}), await api.delete(`/audit-logs/${event!.id}`), await api.put(`/audit-logs/${event!.id}`, {})]) {
        expect(res.status).toBe(404);
      }
    });
  });

  describe("filters, order and pagination", () => {
    it("filters by from (inclusive) / to (exclusive), action CSV, userId and resource; most recent first, stable with equal timestamps", async () => {
      const { org, actors } = await shop("Audit Filters");
      const resource = randomUUID();
      const t = (s: number) => new Date(Date.UTC(2020, 0, 1, 0, 0, s));
      // Raw rows (owner identity) with controlled timestamps, several sharing the same instant.
      const rows = [
        { at: t(0), action: "product.created" },
        { at: t(10), action: "product.updated" },
        { at: t(10), action: "product.updated" },
        { at: t(10), action: "product.activated" },
        { at: t(20), action: "product.deactivated" },
      ];
      for (const r of rows) {
        await owner.auditLog.create({
          data: { tenantId: org.tenantId, userId: actors.manager.userId, action: r.action, resourceType: "product", resourceId: resource, createdAt: r.at },
        });
      }
      const ids = await owner.auditLog.findMany({ where: { tenantId: org.tenantId, resourceId: resource }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
      const q = { resourceType: "product", resourceId: resource };
      const pages: string[] = [];
      for (let page = 1; page <= 3; page++) pages.push(...(await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, pageSize: "2", page: String(page) }))).items.map((i) => i.id));
      expect(pages).toEqual(ids.map((r) => r.id));

      const window = await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, from: t(10).toISOString(), to: "2020-01-01T00:00:20Z" }));
      expect(window.total).toBe(3);
      expect(window.items.every((i) => i.createdAt === t(10).toISOString())).toBe(true);
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, from: "2019-12-31T21:00:10-03:00" }))).total).toBe(4);
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, action: "product.created,product.deactivated" }))).items.map((i) => i.action)).toEqual([
        "product.deactivated",
        "product.created",
      ]);
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, userId: actors.manager.userId }))).total).toBe(5);
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, userId: actors.owner.userId }))).total).toBe(0);
      expect((await ok<Page<AuditLogDto>>(list(actors.owner, { resourceType: "order", resourceId: resource }))).total).toBe(0);
      const item = (await ok<Page<AuditLogDto>>(list(actors.owner, { ...q, pageSize: "1" }))).items[0]!;
      expect(item).toMatchObject({ actor: await actorOf(org, actors.manager), branch: null, metadata: null });
    });

    it("rejects invalid queries with 400 validation_failed", async () => {
      const { actors } = await shop("Audit Bad Query");
      const bad = async (query: Record<string, string>, details: unknown) =>
        expect(await list(actors.owner, query)).toEqual({ status: 400, body: { error: "validation_failed", details } });
      await bad({ from: "2026-11-11T00:00:00Z", to: "2026-11-10T00:00:00Z" }, [{ field: "from", issue: "invalid_value" }]);
      await bad({ from: "ontem" }, [{ field: "from", issue: "invalid_format" }]);
      await bad({ action: "product.deleted" }, [{ field: "action", issue: "invalid_value" }]);
      await bad({ userId: "123" }, [{ field: "userId", issue: "invalid_format" }]);
      await bad({ tenantId: randomUUID() }, [{ field: "tenantId", issue: "unknown_field" }]);
      await bad({ pageSize: "101" }, [{ field: "pageSize", issue: "invalid_value" }]);
    });
  });

  describe("secrets", () => {
    it("no event contains the password used, a password hash or a token", async () => {
      const { org, actors, api } = await shop("Audit Secrets");
      const temporary = "Temporaria-Secreta-987";
      const reset = "Reset-Secreta-654";
      const created = await ok<UserDto>(api.post("/users", { name: "Novo", employeeNumber: "n-77", temporaryPassword: temporary }), 201);
      await ok(api.patch(`/users/${created.id}`, { name: "Novo Nome" }));
      await ok(api.post(`/users/${created.id}/reset-password`, { temporaryPassword: reset }));
      // Failed logins (wrong password typed, and a password typed in the employee number field).
      await expect(h.auth.login({ tenantId: org.tenantId }, { employeeNumber: "N-77", password: "Errada-Senha-111" })).rejects.toThrow();
      await expect(h.auth.login({ tenantId: org.tenantId }, { employeeNumber: "Senha-No-Campo-222", password: "x" })).rejects.toThrow();
      const product = await ok<ProductDto>(api.post("/products", { name: "Água", basePrice: "3.00" }), 201);
      await ok(api.patch(`/products/${product.id}`, { basePrice: "4.00" }));

      const events = await owner.auditLog.findMany({ where: { tenantId: org.tenantId } });
      expect(events.length).toBeGreaterThan(8);
      const hashes = (await owner.user.findMany({ where: { tenantId: org.tenantId }, select: { passwordHash: true } })).map((u) => u.passwordHash);
      const secrets = [DEFAULT_PASSWORD, temporary, reset, "Errada-Senha-111", "Senha-No-Campo-222", actors.owner.token, actors.owner.refreshToken, ...hashes];
      const text = JSON.stringify(events);
      for (const secret of secrets) expect(text.includes(secret), "leaked secret").toBe(false);
      expect(text).not.toMatch(/\$argon2/);
      // Metadata keys never look like credentials (action names such as auth.password.reset are fine).
      const keys = JSON.stringify(events.map((e) => e.metadata), (key, value: unknown) => (key === "" || typeof value === "object" ? value : key));
      expect(keys).not.toMatch(/password|senha|hash|token/i);
      const read = JSON.stringify(await ok<Page<AuditLogDto>>(list(actors.owner, { pageSize: "100" })));
      for (const secret of secrets) expect(read.includes(secret), "leaked secret").toBe(false);
    });
  });
});
