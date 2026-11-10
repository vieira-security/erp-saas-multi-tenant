import { randomUUID } from "node:crypto";
import type { BranchProductSettingDto, MenuDto, Page, ProductCategoryDto, ProductDto, ProductSummaryDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

type Role = "OWNER" | "MANAGER" | "ATTENDANT" | "KITCHEN";

const NOT_FOUND = { status: 404, body: { error: "not_found" } };
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const LINK_INVALID = { status: 409, body: { error: "linked_product_invalid" } };
const PRODUCT_KEYS = ["basePrice", "categoryId", "code", "createdAt", "description", "id", "name", "optionGroups", "sortOrder", "status", "updatedAt"];

// M4 over real HTTP: AppModule (AuthGuard, PermissionGuard, filters), runtime identity erp_app, default roles provisioned.
describe("M4 products APIs over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config);
    await ensurePermissionCatalog(owner);
    orgA = await seedOrg(owner, "Org A");
    orgB = await seedOrg(owner, "Org B");
    for (const org of [orgA, orgB]) await provision(org);
    // Every default role, tenant-wide, with access to MAIN only (not OTHER).
    for (const role of ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN"] as const) tokens[`A:${role}`] = await login(orgA, role, [orgA.branchId]);
    tokens["A:NONE"] = await login(orgA, null, [orgA.branchId]);
    tokens["B:OWNER"] = await login(orgB, "OWNER", [orgB.branchId]);
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  async function provision(org: Org): Promise<void> {
    await h.tenants.run({ tenantId: org.tenantId }, () => new TenantProvisioningService(prisma, h.scope).provisionDefaultRoles());
  }

  /** User with `role` tenant-wide (or none) and access to `branches`, logged in; returns the access token. */
  async function login(org: Org, role: Role | null, branches: string[]): Promise<string> {
    const user = await seedUser(owner, org.tenantId);
    for (const branchId of branches) await owner.userBranchAccess.create({ data: { tenantId: org.tenantId, userId: user.id, branchId } });
    if (role) {
      const { id: roleId } = await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: org.tenantId, code: role } } });
      await owner.userRole.create({ data: { tenantId: org.tenantId, userId: user.id, roleId } });
    }
    return (await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123" })).accessToken;
  }

  /** HTTP client bound to a token. */
  function client(token: string) {
    return {
      get: (path: string) => http.request(path, { token }),
      post: (path: string, body?: unknown) => http.request(path, { method: "POST", token, ...(body !== undefined ? { body } : {}) }),
      patch: (path: string, body: unknown) => http.request(path, { method: "PATCH", token, body }),
      put: (path: string, body: unknown) => http.request(path, { method: "PUT", token, body }),
      del: (path: string) => http.request(path, { method: "DELETE", token }),
    };
  }
  type Client = ReturnType<typeof client>;

  /** Isolated tenant with an OWNER that can reach both branches. */
  async function freshOrg(name: string): Promise<{ org: Org; api: Client }> {
    const org = await seedOrg(owner, name);
    await provision(org);
    return { org, api: client(await login(org, "OWNER", [org.branchId, org.otherBranchId])) };
  }

  const A = (role: Role | "NONE") => client(tokens[`A:${role}`]!);
  const B = () => client(tokens["B:OWNER"]!);

  async function createProduct(api: Client, body: Record<string, unknown>): Promise<ProductDto> {
    const res = await api.post("/products", { basePrice: "10.00", ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ProductDto;
  }

  async function createCategory(api: Client, body: Record<string, unknown>): Promise<ProductCategoryDto> {
    const res = await api.post("/product-categories", body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ProductCategoryDto;
  }

  const sizeGroup = { name: "Tamanho", minChoices: 1, maxChoices: 1, options: [{ name: "P" }, { name: "G", priceDelta: "4" }] };
  const linkGroup = (...ids: string[]) => ({ name: "Bebida", minChoices: 1, maxChoices: 1, options: ids.map((id, i) => ({ name: `B${i}`, linkedProductId: id })) });

  describe("authentication and authorization", () => {
    const tenantRoutes = (id: string): [string, string][] => [
      ["GET", "/product-categories"],
      ["POST", "/product-categories"],
      ["PATCH", `/product-categories/${id}`],
      ["POST", `/product-categories/${id}/activate`],
      ["POST", `/product-categories/${id}/deactivate`],
      ["GET", "/products"],
      ["GET", `/products/${id}`],
      ["POST", "/products"],
      ["PATCH", `/products/${id}`],
      ["PUT", `/products/${id}/option-groups`],
      ["POST", `/products/${id}/activate`],
      ["POST", `/products/${id}/deactivate`],
    ];
    const branchRoutes = (branchId: string, id: string): [string, string][] => [
      ["GET", `/branches/${branchId}/product-settings`],
      ["PUT", `/branches/${branchId}/product-settings/${id}`],
      ["DELETE", `/branches/${branchId}/product-settings/${id}`],
      ["GET", `/branches/${branchId}/menu`],
    ];
    const send = (token: string, method: string, path: string) =>
      http.request(path, { method, token, ...(method === "POST" || method === "PATCH" || method === "PUT" ? { body: {} } : {}) });

    it("requires a token on every route", async () => {
      for (const [method, path] of [...tenantRoutes(randomUUID()), ...branchRoutes(orgA.branchId, randomUUID())]) {
        expect(await http.request(path, { method }), `${method} ${path}`).toEqual({ status: 401, body: { error: "unauthenticated" } });
      }
    });

    it("OWNER and MANAGER manage; ATTENDANT and KITCHEN only read; a user without role gets 403", async () => {
      const product = await createProduct(A("OWNER"), { name: "Matriz" });
      for (const [method, path] of [...tenantRoutes(product.id), ...branchRoutes(orgA.branchId, product.id)]) {
        const read = method === "GET";
        for (const role of ["OWNER", "MANAGER", "ATTENDANT", "KITCHEN", "NONE"] as const) {
          const allowed = role === "OWNER" || role === "MANAGER" || (read && role !== "NONE");
          const res = await send(tokens[`A:${role}`]!, method, path);
          if (allowed) expect(res.status, `${method} ${path} as ${role}: ${JSON.stringify(res.body)}`).not.toBe(403);
          else expect(res, `${method} ${path} as ${role}`).toEqual(FORBIDDEN);
        }
      }
    });

    it("branch routes require access to THAT branch, even with a tenant-wide role (other branch, other tenant, missing, malformed)", async () => {
      const product = await createProduct(A("OWNER"), { name: "Escopo" });
      for (const branchId of [orgA.otherBranchId, orgB.branchId, randomUUID(), "not-a-uuid"]) {
        for (const [method, path] of branchRoutes(branchId, product.id)) {
          expect(await send(tokens["A:OWNER"]!, method, path), `${method} ${path}`).toEqual(FORBIDDEN);
        }
      }
      expect(await owner.branchProductSetting.count({ where: { productId: product.id } })).toBe(0);
    });
  });

  describe("categories", () => {
    it("creates with trimming and defaults, lists by sortOrder then creation, filters by status", async () => {
      const { api } = await freshOrg("Categorias");
      const drinks = await createCategory(api, { name: "  Bebidas  ", sortOrder: 2 });
      expect(drinks).toMatchObject({ name: "Bebidas", sortOrder: 2, status: "ACTIVE" });
      expect(Object.keys(drinks).sort()).toEqual(["createdAt", "id", "name", "sortOrder", "status", "updatedAt"]);
      const food = await createCategory(api, { name: "Lanches" });
      const desserts = await createCategory(api, { name: "Sobremesas", sortOrder: 2 });
      expect(food.sortOrder).toBe(0);
      expect(((await api.get("/product-categories")).body as ProductCategoryDto[]).map((c) => c.id)).toEqual([food.id, drinks.id, desserts.id]);
      await api.post(`/product-categories/${food.id}/deactivate`);
      expect(((await api.get("/product-categories?status=INACTIVE")).body as ProductCategoryDto[]).map((c) => c.id)).toEqual([food.id]);
      expect(((await api.get("/product-categories?status=ACTIVE")).body as ProductCategoryDto[]).map((c) => c.id)).toEqual([drinks.id, desserts.id]);
      expect(await api.get("/product-categories?status=DELETED&page=1")).toEqual({
        status: 400,
        body: { error: "validation_failed", details: [{ field: "page", issue: "unknown_field" }, { field: "status", issue: "invalid_value" }] },
      });
    });

    it("validates the body and rejects mass assignment", async () => {
      expect(await A("OWNER").post("/product-categories", { name: " ", sortOrder: 10000, status: "INACTIVE", tenantId: orgB.tenantId })).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "status", issue: "unknown_field" },
            { field: "tenantId", issue: "unknown_field" },
            { field: "name", issue: "too_short" },
            { field: "sortOrder", issue: "invalid_value" },
          ],
        },
      });
      expect((await A("OWNER").post("/product-categories", { name: "x".repeat(81), sortOrder: 1.5 })).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "name", issue: "too_long" },
          { field: "sortOrder", issue: "invalid_type" },
        ],
      });
    });

    it("updates, keeps empty PATCH as a no-op and toggles status idempotently", async () => {
      const { api } = await freshOrg("Cat patch");
      const category = await createCategory(api, { name: "Lanches" });
      expect(await api.patch(`/product-categories/${category.id}`, { name: "Lanches Top", sortOrder: 5 })).toMatchObject({
        status: 200,
        body: { name: "Lanches Top", sortOrder: 5 },
      });
      const before = (await owner.productCategory.findUniqueOrThrow({ where: { id: category.id } })).updatedAt;
      expect((await api.patch(`/product-categories/${category.id}`, {})).status).toBe(200);
      expect((await owner.productCategory.findUniqueOrThrow({ where: { id: category.id } })).updatedAt).toEqual(before);
      for (const [action, status] of [["deactivate", "INACTIVE"], ["deactivate", "INACTIVE"], ["activate", "ACTIVE"], ["activate", "ACTIVE"]] as const) {
        expect(await api.post(`/product-categories/${category.id}/${action}`)).toMatchObject({ status: 200, body: { status } });
      }
    });

    it("another tenant's category is indistinguishable from a missing one", async () => {
      const category = await createCategory(A("OWNER"), { name: "Segredo" });
      for (const id of [category.id, randomUUID(), "not-a-uuid"]) {
        expect(await B().patch(`/product-categories/${id}`, { name: "Hack" })).toEqual(NOT_FOUND);
        expect(await B().post(`/product-categories/${id}/deactivate`)).toEqual(NOT_FOUND);
        expect(await B().post(`/product-categories/${id}/activate`)).toEqual(NOT_FOUND);
      }
      expect(((await B().get("/product-categories")).body as ProductCategoryDto[]).map((c) => c.id)).not.toContain(category.id);
      expect(await owner.productCategory.findUniqueOrThrow({ where: { id: category.id } })).toMatchObject({ name: "Segredo", status: "ACTIVE" });
    });
  });

  describe("products", () => {
    it("creates with normalized fields and exactly the contract keys", async () => {
      const { api } = await freshOrg("Produto");
      const category = await createCategory(api, { name: "Lanches" });
      const product = await createProduct(api, {
        name: "  X-Burger ",
        description: "  Pão, carne e queijo  ",
        code: " xb-01 ",
        categoryId: category.id.toUpperCase(),
        basePrice: "12.5",
        sortOrder: 3,
        optionGroups: [sizeGroup],
      });
      expect(product).toMatchObject({
        name: "X-Burger",
        description: "Pão, carne e queijo",
        code: "XB-01",
        categoryId: category.id,
        basePrice: "12.50",
        sortOrder: 3,
        status: "ACTIVE",
      });
      expect(Object.keys(product).sort()).toEqual(PRODUCT_KEYS);
      expect(product.optionGroups).toMatchObject([
        { name: "Tamanho", minChoices: 1, maxChoices: 1, sortOrder: 0, options: [{ name: "P", priceDelta: "0.00", linkedProductId: null, sortOrder: 0 }, { name: "G", priceDelta: "4.00", sortOrder: 1 }] },
      ]);
      expect(Object.keys(product.optionGroups[0]!.options[0]!).sort()).toEqual(["id", "linkedProductId", "name", "priceDelta", "sortOrder"]);
      expect(await api.get(`/products/${product.id}`)).toEqual({ status: 200, body: product });

      const minimal = await createProduct(api, { name: "Água", description: "   ", code: null, categoryId: null });
      expect(minimal).toMatchObject({ description: null, code: null, categoryId: null, sortOrder: 0, optionGroups: [] });
    });

    it("validates every field (Money never as number) and rejects mass assignment", async () => {
      expect(
        await A("OWNER").post("/products", {
          name: "",
          code: "X B",
          basePrice: 12.5,
          sortOrder: -1,
          categoryId: "nope",
          description: "x".repeat(501),
          status: "INACTIVE",
          tenantId: orgB.tenantId,
          id: randomUUID(),
        }),
      ).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "status", issue: "unknown_field" },
            { field: "tenantId", issue: "unknown_field" },
            { field: "id", issue: "unknown_field" },
            { field: "name", issue: "too_short" },
            { field: "description", issue: "too_long" },
            { field: "code", issue: "invalid_format" },
            { field: "categoryId", issue: "invalid_format" },
            { field: "basePrice", issue: "invalid_money" },
            { field: "sortOrder", issue: "invalid_value" },
          ],
        },
      });
      for (const basePrice of ["1e3", "-1", "1,50", "10000000000", "1.005", null]) {
        expect((await A("OWNER").post("/products", { name: "P", basePrice })).body, String(basePrice)).toEqual({
          error: "validation_failed",
          details: [{ field: "basePrice", issue: "invalid_money" }],
        });
      }
      expect((await A("OWNER").post("/products", { name: "P" })).body).toEqual({ error: "validation_failed", details: [{ field: "basePrice", issue: "required" }] });
    });

    it("accepts a category of any status of the tenant; another tenant's or a missing category is 404", async () => {
      const { api } = await freshOrg("Prod cat");
      const inactive = await createCategory(api, { name: "Antiga" });
      await api.post(`/product-categories/${inactive.id}/deactivate`);
      expect((await createProduct(api, { name: "P", categoryId: inactive.id })).categoryId).toBe(inactive.id);
      const foreign = await createCategory(A("OWNER"), { name: "De A" });
      expect(await api.post("/products", { name: "P", basePrice: "1", categoryId: foreign.id })).toEqual(NOT_FOUND);
      expect(await api.post("/products", { name: "P", basePrice: "1", categoryId: randomUUID() })).toEqual(NOT_FOUND);
      const mine = await createProduct(api, { name: "Q" });
      expect(await api.patch(`/products/${mine.id}`, { categoryId: foreign.id })).toEqual(NOT_FOUND);
      expect((await api.patch(`/products/${mine.id}`, { categoryId: inactive.id })).body).toMatchObject({ categoryId: inactive.id });
      expect((await api.patch(`/products/${mine.id}`, { categoryId: null })).body).toMatchObject({ categoryId: null });
    });

    it("keeps the code unique per tenant (409), allows many products without code and the same code elsewhere", async () => {
      const { api } = await freshOrg("Codes");
      const first = await createProduct(api, { name: "A", code: "COCA" });
      expect(await api.post("/products", { name: "B", basePrice: "1", code: "coca" })).toEqual({ status: 409, body: { error: "product_code_already_exists" } });
      await createProduct(api, { name: "C" });
      await createProduct(api, { name: "D", code: null });
      const other = await createProduct(api, { name: "E", code: "PEPSI" });
      expect(await api.patch(`/products/${other.id}`, { code: "COCA" })).toEqual({ status: 409, body: { error: "product_code_already_exists" } });
      expect((await api.patch(`/products/${first.id}`, { code: "coca" })).status).toBe(200);
      expect((await api.patch(`/products/${other.id}`, { code: null })).body).toMatchObject({ code: null });
      expect((await createProduct(B(), { name: "Coca B", code: "COCA" })).code).toBe("COCA");
    });

    it("updates fields, ignores an empty PATCH and never changes status or groups through PATCH", async () => {
      const { api } = await freshOrg("Prod patch");
      const product = await createProduct(api, { name: "Suco", description: "Natural", optionGroups: [sizeGroup] });
      const res = await api.patch(`/products/${product.id}`, { name: "Suco de Laranja", description: "", basePrice: "8", sortOrder: 9 });
      expect(res).toMatchObject({ status: 200, body: { name: "Suco de Laranja", description: null, basePrice: "8.00", sortOrder: 9, status: "ACTIVE" } });
      expect((res.body as ProductDto).optionGroups).toHaveLength(1);
      const before = (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).updatedAt;
      expect((await api.patch(`/products/${product.id}`, {})).status).toBe(200);
      expect((await owner.product.findUniqueOrThrow({ where: { id: product.id } })).updatedAt).toEqual(before);
      expect((await api.patch(`/products/${product.id}`, { status: "INACTIVE", optionGroups: [], tenantId: orgB.tenantId })).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "status", issue: "unknown_field" },
          { field: "optionGroups", issue: "unknown_field" },
          { field: "tenantId", issue: "unknown_field" },
        ],
      });
    });

    it("activates and deactivates idempotently", async () => {
      const { api } = await freshOrg("Prod status");
      const product = await createProduct(api, { name: "P" });
      for (const [action, status] of [["deactivate", "INACTIVE"], ["deactivate", "INACTIVE"], ["activate", "ACTIVE"], ["activate", "ACTIVE"]] as const) {
        expect(await api.post(`/products/${product.id}/${action}`)).toMatchObject({ status: 200, body: { status } });
      }
    });

    it("another tenant's product is 404 on every route and is never changed", async () => {
      const product = await createProduct(A("OWNER"), { name: "Privado", code: "PRIV" });
      for (const id of [product.id, randomUUID(), "not-a-uuid"]) {
        expect(await B().get(`/products/${id}`), id).toEqual(NOT_FOUND);
        expect(await B().patch(`/products/${id}`, { name: "Hack" })).toEqual(NOT_FOUND);
        expect(await B().put(`/products/${id}/option-groups`, { optionGroups: [] })).toEqual(NOT_FOUND);
        expect(await B().post(`/products/${id}/activate`)).toEqual(NOT_FOUND);
        expect(await B().post(`/products/${id}/deactivate`)).toEqual(NOT_FOUND);
      }
      expect(((await B().get("/products?q=PRIV")).body as Page<ProductSummaryDto>).total).toBe(0);
      expect(await owner.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ name: "Privado", status: "ACTIVE" });
    });

    it("lists the tenant's products paginated by creation, with filters, search and group count", async () => {
      const { api } = await freshOrg("Lista");
      const category = await createCategory(api, { name: "Bebidas" });
      const coke = await createProduct(api, { name: "Coca-Cola Lata", code: "COCA", categoryId: category.id, optionGroups: [sizeGroup] });
      const juice = await createProduct(api, { name: "Suco 100%", categoryId: category.id });
      const burger = await createProduct(api, { name: "X-Burger", code: "XB" });
      await api.post(`/products/${juice.id}/deactivate`);

      const page1 = (await api.get("/products?pageSize=2")).body as Page<ProductSummaryDto>;
      expect(page1).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
      expect(page1.items.map((p) => p.id)).toEqual([coke.id, juice.id]);
      expect(page1.items[0]).toMatchObject({ optionGroupCount: 1, basePrice: "10.00", categoryId: category.id });
      expect(Object.keys(page1.items[0]!).sort()).toEqual(
        ["basePrice", "categoryId", "code", "createdAt", "id", "name", "optionGroupCount", "sortOrder", "status", "updatedAt"],
      );
      expect(((await api.get("/products?pageSize=2&page=2")).body as Page<ProductSummaryDto>).items.map((p) => p.id)).toEqual([burger.id]);

      const ids = async (query: string) => ((await api.get(`/products?${query}`)).body as Page<ProductSummaryDto>).items.map((p) => p.id);
      expect(await ids(`categoryId=${category.id}`)).toEqual([coke.id, juice.id]);
      expect(await ids("status=INACTIVE")).toEqual([juice.id]);
      expect(await ids("q=coca")).toEqual([coke.id]);
      expect(await ids("q=xb")).toEqual([burger.id]); // exact code, case-normalized
      expect(await ids("q=X")).toEqual([burger.id]); // name contains "x" (no code "X")
      expect(await ids(`q=${encodeURIComponent("100%")}`)).toEqual([juice.id]);
      expect(await ids(`q=${encodeURIComponent("%")}`)).toEqual([juice.id]); // literal %, not a wildcard
      expect(await ids("q=_")).toEqual([]);
      expect(await ids(`q=${encodeURIComponent("\\")}`)).toEqual([]);
      expect(await ids(`q=${encodeURIComponent("Coca_Cola")}`)).toEqual([]); // "_" is not "any character"
      expect(await ids(`categoryId=${randomUUID()}`)).toEqual([]);
      expect((await api.get("/products?q=&status=X&categoryId=1")).body).toEqual({
        error: "validation_failed",
        details: [
          { field: "categoryId", issue: "invalid_format" },
          { field: "status", issue: "invalid_value" },
          { field: "q", issue: "too_short" },
        ],
      });
    });
  });

  describe("option groups (PUT /products/:id/option-groups)", () => {
    it("replaces all groups in order, and an empty list removes them", async () => {
      const { api } = await freshOrg("Grupos");
      const product = await createProduct(api, { name: "Pizza", optionGroups: [sizeGroup] });
      const oldIds = product.optionGroups.flatMap((g) => [g.id, ...g.options.map((o) => o.id)]);
      const res = await api.put(`/products/${product.id}/option-groups`, {
        optionGroups: [
          { name: "Borda", minChoices: 0, maxChoices: 1, options: [{ name: "Catupiry", priceDelta: "6.00" }] },
          { name: "Extras", minChoices: 0, maxChoices: 2, options: [{ name: "Bacon", priceDelta: "4" }, { name: "Milho" }, { name: "Ovo", priceDelta: "2.5" }] },
        ],
      });
      expect(res.status).toBe(200);
      const body = res.body as ProductDto;
      expect(body.optionGroups.map((g) => [g.name, g.sortOrder, g.options.map((o) => `${o.name}:${o.priceDelta}:${o.sortOrder}`)])).toEqual([
        ["Borda", 0, ["Catupiry:6.00:0"]],
        ["Extras", 1, ["Bacon:4.00:0", "Milho:0.00:1", "Ovo:2.50:2"]],
      ]);
      expect(body.updatedAt > product.updatedAt).toBe(true);
      expect(await owner.productOptionGroup.count({ where: { id: { in: oldIds } } })).toBe(0);
      expect(await owner.productOption.count({ where: { id: { in: oldIds } } })).toBe(0);

      expect((await api.put(`/products/${product.id}/option-groups`, { optionGroups: [] })).body).toMatchObject({ optionGroups: [] });
      expect(await owner.productOptionGroup.count({ where: { productId: product.id } })).toBe(0);
    });

    it("validates groups and options with field paths, without touching the current groups", async () => {
      const { api } = await freshOrg("Grupos val");
      const product = await createProduct(api, { name: "P", optionGroups: [sizeGroup] });
      expect(
        await api.put(`/products/${product.id}/option-groups`, {
          optionGroups: [
            { name: "A", minChoices: 2, maxChoices: 1, options: [{ name: "x" }] },
            { name: "B", minChoices: 0, maxChoices: 3, options: [{ name: "x" }, { name: "y", priceDelta: 1 }] },
            { name: "C", minChoices: 0, maxChoices: 1, options: [] },
          ],
          extra: true,
        }),
      ).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "extra", issue: "unknown_field" },
            { field: "optionGroups[0].minChoices", issue: "min_greater_than_max" },
            { field: "optionGroups[1].options[1].priceDelta", issue: "invalid_money" },
            { field: "optionGroups[2].options", issue: "too_few" },
          ],
        },
      });
      expect((await api.put(`/products/${product.id}/option-groups`, { optionGroups: Array.from({ length: 21 }, () => sizeGroup) })).body).toEqual({
        error: "validation_failed",
        details: [{ field: "optionGroups", issue: "too_many" }],
      });
      expect((await api.put(`/products/${product.id}/option-groups`, {})).body).toEqual({
        error: "validation_failed",
        details: [{ field: "optionGroups", issue: "required" }],
      });
      expect(((await api.get(`/products/${product.id}`)).body as ProductDto).optionGroups.map((g) => g.id)).toEqual(product.optionGroups.map((g) => g.id));
    });

    it("combo: the linked product must exist in the tenant (404), be ACTIVE, not be itself and have no groups (409)", async () => {
      const { org, api } = await freshOrg("Combo");
      const combo = await createProduct(api, { name: "Combo" });
      const drink = await createProduct(api, { name: "Refri" });
      const inactive = await createProduct(api, { name: "Antigo" });
      await api.post(`/products/${inactive.id}/deactivate`);
      const withGroups = await createProduct(api, { name: "Pizza", optionGroups: [sizeGroup] });
      const foreign = await createProduct(A("OWNER"), { name: "De A" });
      const replace = (...ids: string[]) => api.put(`/products/${combo.id}/option-groups`, { optionGroups: [linkGroup(...ids)] });

      expect(await replace(foreign.id)).toEqual(NOT_FOUND);
      expect(await replace(randomUUID())).toEqual(NOT_FOUND);
      expect(await replace(drink.id, foreign.id)).toEqual(NOT_FOUND);
      expect(await replace(inactive.id)).toEqual(LINK_INVALID);
      expect(await replace(combo.id)).toEqual(LINK_INVALID);
      expect(await replace(withGroups.id)).toEqual(LINK_INVALID);
      expect(await api.post("/products", { name: "Novo", basePrice: "1", optionGroups: [linkGroup(withGroups.id)] })).toEqual(LINK_INVALID);
      expect(await api.post("/products", { name: "Novo", basePrice: "1", optionGroups: [linkGroup(foreign.id)] })).toEqual(NOT_FOUND);
      expect(await owner.product.count({ where: { tenantId: org.tenantId, name: "Novo" } })).toBe(0);
      expect(await owner.productOptionGroup.count({ where: { productId: combo.id } })).toBe(0);

      const ok = await replace(drink.id);
      expect(ok.status).toBe(200);
      expect((ok.body as ProductDto).optionGroups[0]?.options[0]).toMatchObject({ linkedProductId: drink.id, priceDelta: "0.00" });
      expect((await createProduct(api, { name: "Combo 2", optionGroups: [linkGroup(drink.id)] })).optionGroups[0]?.options[0]?.linkedProductId).toBe(drink.id);
    });

    it("combo does not nest: a product already linked by another cannot receive groups (an empty list is fine)", async () => {
      const { api } = await freshOrg("Combo aninhado");
      const drink = await createProduct(api, { name: "Refri" });
      await createProduct(api, { name: "Combo", optionGroups: [linkGroup(drink.id)] });
      expect(await api.put(`/products/${drink.id}/option-groups`, { optionGroups: [sizeGroup] })).toEqual(LINK_INVALID);
      expect((await api.put(`/products/${drink.id}/option-groups`, { optionGroups: [] })).status).toBe(200);
      expect(await owner.productOptionGroup.count({ where: { productId: drink.id } })).toBe(0);
    });

    it("deactivating a linked product does not touch the groups of the products that link it", async () => {
      const { api } = await freshOrg("Desativa vinculado");
      const drink = await createProduct(api, { name: "Refri" });
      const combo = await createProduct(api, { name: "Combo", optionGroups: [linkGroup(drink.id)] });
      await api.post(`/products/${drink.id}/deactivate`);
      expect(((await api.get(`/products/${combo.id}`)).body as ProductDto).optionGroups).toEqual(combo.optionGroups);
    });
  });

  describe("branch product settings", () => {
    it("upserts idempotently, lists only the branch's settings and deletes idempotently", async () => {
      const { org, api } = await freshOrg("Ajustes");
      const product = await createProduct(api, { name: "Coxinha", basePrice: "7.00" });
      const path = `/branches/${org.branchId}/product-settings/${product.id}`;

      const created = await api.put(path, { available: false, price: "7.5" });
      expect(created).toMatchObject({ status: 200, body: { branchId: org.branchId, productId: product.id, available: false, price: "7.50" } });
      expect(Object.keys(created.body as object).sort()).toEqual(["available", "branchId", "price", "productId", "updatedAt"]);
      const again = await api.put(path, { available: false, price: "7.50" });
      expect(again).toEqual(created);
      const changed = await api.put(path, { available: true, price: null });
      expect(changed).toMatchObject({ status: 200, body: { available: true, price: null } });
      expect(await owner.branchProductSetting.count({ where: { productId: product.id } })).toBe(1);

      await api.put(`/branches/${org.otherBranchId}/product-settings/${product.id}`, { available: false, price: null });
      const list = (await api.get(`/branches/${org.branchId}/product-settings`)).body as BranchProductSettingDto[];
      expect(list.map((s) => [s.branchId, s.productId])).toEqual([[org.branchId, product.id]]);

      expect(await api.del(path)).toEqual({ status: 204, body: null });
      expect(await api.del(path)).toEqual({ status: 204, body: null });
      expect(await api.del(`/branches/${org.branchId}/product-settings/${randomUUID()}`)).toEqual({ status: 204, body: null });
      expect(await api.get(`/branches/${org.branchId}/product-settings`)).toEqual({ status: 200, body: [] });
    });

    it("validates the body and 404s for another tenant's, a missing or a malformed product", async () => {
      const path = (productId: string) => `/branches/${orgA.branchId}/product-settings/${productId}`;
      const mine = await createProduct(A("OWNER"), { name: "Ajustável" });
      expect(await A("OWNER").put(path(mine.id), { available: "yes", price: 7.5, branchId: orgB.branchId })).toEqual({
        status: 400,
        body: {
          error: "validation_failed",
          details: [
            { field: "branchId", issue: "unknown_field" },
            { field: "available", issue: "invalid_type" },
            { field: "price", issue: "invalid_money" },
          ],
        },
      });
      expect((await A("OWNER").put(path(mine.id), { available: true })).body).toEqual({ error: "validation_failed", details: [{ field: "price", issue: "required" }] });
      const foreign = await createProduct(B(), { name: "De B" });
      for (const id of [foreign.id, randomUUID(), "nope"]) expect(await A("OWNER").put(path(id), { available: true, price: null })).toEqual(NOT_FOUND);
      expect(await owner.branchProductSetting.count({ where: { productId: foreign.id } })).toBe(0);
    });
  });

  describe("branch menu (GET /branches/:branchId/menu)", () => {
    it("sells only ACTIVE products available in the branch, at the effective price, with active non-empty categories", async () => {
      const { org, api } = await freshOrg("Cardápio");
      const food = await createCategory(api, { name: "Lanches", sortOrder: 1 });
      const drinks = await createCategory(api, { name: "Bebidas", sortOrder: 2 });
      const empty = await createCategory(api, { name: "Vazia", sortOrder: 0 });
      const old = await createCategory(api, { name: "Antiga", sortOrder: 3 });
      const burger = await createProduct(api, { name: "X-Burger", categoryId: food.id, basePrice: "25.00", sortOrder: 1 });
      const fries = await createProduct(api, { name: "Batata", categoryId: food.id, basePrice: "12.00", sortOrder: 0 });
      const coke = await createProduct(api, { name: "Coca", categoryId: drinks.id, basePrice: "6.00" });
      const off = await createProduct(api, { name: "Sem estoque", categoryId: drinks.id });
      const inactive = await createProduct(api, { name: "Inativo", categoryId: empty.id });
      const orphan = await createProduct(api, { name: "Órfão", categoryId: old.id, basePrice: "3" });
      await api.post(`/products/${inactive.id}/deactivate`);
      await api.post(`/product-categories/${old.id}/deactivate`);
      await api.put(`/branches/${org.branchId}/product-settings/${off.id}`, { available: false, price: null });
      await api.put(`/branches/${org.branchId}/product-settings/${burger.id}`, { available: true, price: "27.90" });
      // Settings of the other branch never leak into this menu.
      await api.put(`/branches/${org.otherBranchId}/product-settings/${coke.id}`, { available: false, price: "1.00" });

      const res = await api.get(`/branches/${org.branchId}/menu`);
      expect(res.status).toBe(200);
      const menu = res.body as MenuDto;
      expect(menu.branchId).toBe(org.branchId);
      expect(menu.categories).toEqual([
        { id: food.id, name: "Lanches", sortOrder: 1 },
        { id: drinks.id, name: "Bebidas", sortOrder: 2 },
      ]);
      // Global order: sortOrder, then creation (Batata, Coca and Órfão share sortOrder 0).
      expect(menu.products.map((p) => [p.name, p.categoryId, p.price])).toEqual([
        ["Batata", food.id, "12.00"],
        ["Coca", drinks.id, "6.00"],
        ["Órfão", null, "3.00"],
        ["X-Burger", food.id, "27.90"],
      ]);
      expect(Object.keys(menu.products[0]!).sort()).toEqual(["categoryId", "code", "description", "id", "name", "optionGroups", "price"]);
      expect(menu.products[0]?.id).toBe(fries.id);
      expect(menu.products.map((p) => p.id)).not.toContain(off.id);
      expect(menu.products.map((p) => p.id)).not.toContain(inactive.id);
      expect(menu.products.find((p) => p.id === orphan.id)?.categoryId).toBeNull();

      const other = (await api.get(`/branches/${org.otherBranchId}/menu`)).body as MenuDto;
      expect(other.products.map((p) => [p.name, p.price])).toEqual([
        ["Batata", "12.00"],
        ["Sem estoque", "10.00"],
        ["Órfão", "3.00"],
        ["X-Burger", "25.00"],
      ]);
    });

    it("filters combo options of inactive/unavailable products and omits a product whose required group empties", async () => {
      const { org, api } = await freshOrg("Cardápio combo");
      const coke = await createProduct(api, { name: "Coca", basePrice: "6" });
      const juice = await createProduct(api, { name: "Suco", basePrice: "8" });
      const tea = await createProduct(api, { name: "Chá", basePrice: "5" });
      const combo = await createProduct(api, {
        name: "Combo",
        basePrice: "30",
        optionGroups: [
          { name: "Bebida", minChoices: 1, maxChoices: 1, options: [{ name: "Coca", linkedProductId: coke.id }, { name: "Suco", linkedProductId: juice.id, priceDelta: "2" }, { name: "Chá", linkedProductId: tea.id }] },
          { name: "Extras", minChoices: 0, maxChoices: 2, options: [{ name: "Bacon", priceDelta: "4" }, { name: "Chá extra", linkedProductId: tea.id }] },
        ],
      });
      const onlyTea = await createProduct(api, { name: "Só chá", basePrice: "9", optionGroups: [linkGroup(tea.id)] });
      await api.post(`/products/${tea.id}/deactivate`);
      await api.put(`/branches/${org.branchId}/product-settings/${juice.id}`, { available: false, price: null });

      const menu = (await api.get(`/branches/${org.branchId}/menu`)).body as MenuDto;
      const comboItem = menu.products.find((p) => p.id === combo.id)!;
      expect(comboItem.optionGroups.map((g) => [g.name, g.minChoices, g.maxChoices, g.options.map((o) => o.name)])).toEqual([
        ["Bebida", 1, 1, ["Coca"]],
        ["Extras", 0, 1, ["Bacon"]],
      ]);
      expect(menu.products.map((p) => p.id)).not.toContain(onlyTea.id);
      expect(menu.products.map((p) => p.id)).not.toContain(tea.id);

      // In the other branch the juice is available: it comes back with its price delta.
      const other = (await api.get(`/branches/${org.otherBranchId}/menu`)).body as MenuDto;
      expect(other.products.find((p) => p.id === combo.id)!.optionGroups[0]!.options.map((o) => [o.name, o.priceDelta])).toEqual([
        ["Coca", "0.00"],
        ["Suco", "2.00"],
      ]);
    });

    it("an empty catalog is an empty menu", async () => {
      const { org, api } = await freshOrg("Cardápio vazio");
      expect(await api.get(`/branches/${org.branchId}/menu`)).toEqual({ status: 200, body: { branchId: org.branchId, categories: [], products: [] } });
    });
  });

  describe("money precision", () => {
    it("round-trips decimal strings exactly, also at the maximum; 0.10 + 0.20 is 0.30", async () => {
      const { org, api } = await freshOrg("Dinheiro");
      const product = await createProduct(api, {
        name: "Bala",
        basePrice: "0.10",
        optionGroups: [{ name: "Extra", minChoices: 0, maxChoices: 1, options: [{ name: "Mais uma", priceDelta: "0.20" }] }],
      });
      expect(product.basePrice).toBe("0.10");
      expect(product.optionGroups[0]?.options[0]?.priceDelta).toBe("0.20");
      const [row] = await owner.$queryRaw<{ total: string }[]>`
        SELECT (p.base_price + o.price_delta)::text AS total FROM products p JOIN product_options o ON o.product_id = p.id AND o.tenant_id = p.tenant_id
        WHERE p.id = ${product.id}::uuid`;
      expect(row?.total).toBe("0.30");

      const max = await createProduct(api, { name: "Caro", basePrice: "9999999999.99" });
      expect(max.basePrice).toBe("9999999999.99");
      const setting = await api.put(`/branches/${org.branchId}/product-settings/${max.id}`, { available: true, price: "9999999999.99" });
      expect((setting.body as BranchProductSettingDto).price).toBe("9999999999.99");
      expect(((await api.get(`/branches/${org.branchId}/menu`)).body as MenuDto).products.find((p) => p.id === max.id)?.price).toBe("9999999999.99");
    });
  });

  describe("concurrency", () => {
    it("simultaneous creations with the same code: exactly one 201, the rest 409", async () => {
      const { org, api } = await freshOrg("Corrida código");
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api.post("/products", { name: `P${i}`, basePrice: "1", code: "DUP" })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body).toEqual({ error: "product_code_already_exists" });
      expect(await owner.product.count({ where: { tenantId: org.tenantId, code: "DUP" } })).toBe(1);
    });

    it("linking a product while giving it groups never ends in a nested combo", async () => {
      const { org, api } = await freshOrg("Corrida combo");
      for (let round = 0; round < 10; round++) {
        const linked = await createProduct(api, { name: `L${round}` });
        const combo = await createProduct(api, { name: `C${round}` });
        const [link, groups] = await Promise.all([
          api.put(`/products/${combo.id}/option-groups`, { optionGroups: [linkGroup(linked.id)] }),
          api.put(`/products/${linked.id}/option-groups`, { optionGroups: [sizeGroup] }),
        ]);
        const statuses = [link.status, groups.status].sort();
        expect(statuses, `round ${round}: ${JSON.stringify([link.body, groups.body])}`).toEqual([200, 409]);
      }
      // Cross links in parallel (X links Y while Y links X): one wins, no deadlock error.
      for (let round = 0; round < 5; round++) {
        const x = await createProduct(api, { name: `X${round}` });
        const y = await createProduct(api, { name: `Y${round}` });
        const results = await Promise.all([
          api.put(`/products/${x.id}/option-groups`, { optionGroups: [linkGroup(y.id)] }),
          api.put(`/products/${y.id}/option-groups`, { optionGroups: [linkGroup(x.id)] }),
        ]);
        expect(results.map((r) => r.status).sort(), JSON.stringify(results)).toEqual([200, 409]);
      }
      const nested = await owner.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM product_options o
        WHERE o.tenant_id = ${org.tenantId}::uuid AND o.linked_product_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM product_option_groups g WHERE g.tenant_id = o.tenant_id AND g.product_id = o.linked_product_id)`;
      expect(nested[0]?.count).toBe(0);
    });

    it("parallel upserts of the same branch setting converge on one row", async () => {
      const { org, api } = await freshOrg("Corrida ajuste");
      const product = await createProduct(api, { name: "P" });
      const path = `/branches/${org.branchId}/product-settings/${product.id}`;
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api.put(path, { available: i % 2 === 0, price: `${i + 1}.00` })));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(await owner.branchProductSetting.count({ where: { productId: product.id } })).toBe(1);
    });
  });
});
