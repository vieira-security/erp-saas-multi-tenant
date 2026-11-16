import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  ProductCategoryStatus,
  ProductStatus,
  TenantStatus,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";
import { UUID_V7 } from "./uuid.js";

const M4_TABLES = ["product_categories", "products", "product_option_groups", "product_options", "branch_product_settings"] as const;

// M4 schema (migration 20261108000000_create_product_catalog), exercised directly against PostgreSQL as the owner
// identity: CHECKs, uniques, composite tenant-carrying FKs, RESTRICT and numeric(12,2). The HTTP rules live in
// products-http.int.test.ts.
describe("Product catalog (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant + company + branch + category + product with one group and one option. */
  async function newCatalog(name = "Cat") {
    const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await prisma.company.create({
      data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const branch = await prisma.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: "Loja", code: "LOJA", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const category = await prisma.productCategory.create({ data: { tenantId: tenant.id, name: "Lanches", status: ProductCategoryStatus.ACTIVE } });
    const product = await prisma.product.create({
      data: { tenantId: tenant.id, categoryId: category.id, name: "X-Burger", code: "XB", basePrice: "25.00", status: ProductStatus.ACTIVE },
    });
    const drink = await prisma.product.create({ data: { tenantId: tenant.id, name: "Refrigerante", basePrice: "6.00", status: ProductStatus.ACTIVE } });
    const group = await prisma.productOptionGroup.create({
      data: { tenantId: tenant.id, productId: product.id, name: "Bebida", minChoices: 1, maxChoices: 1, sortOrder: 0 },
    });
    const option = await prisma.productOption.create({
      data: { tenantId: tenant.id, productId: product.id, groupId: group.id, name: "Refri", priceDelta: "0.00", linkedProductId: drink.id, sortOrder: 0 },
    });
    return { tenantId: tenant.id, branchId: branch.id, categoryId: category.id, productId: product.id, drinkId: drink.id, groupId: group.id, optionId: option.id };
  }

  type Catalog = Awaited<ReturnType<typeof newCatalog>>;

  const insertCategory = (c: Pick<Catalog, "tenantId">, v: { name?: string; sortOrder?: number } = {}) =>
    prisma.$executeRaw`INSERT INTO product_categories (id, tenant_id, name, sort_order, status, updated_at)
      VALUES (gen_random_uuid(), ${c.tenantId}::uuid, ${v.name ?? "Bebidas"}, ${v.sortOrder ?? 0}, 'ACTIVE', now())`;

  const insertProduct = (
    tenantId: string,
    v: { categoryId?: string | null; name?: string; description?: string | null; code?: string | null; basePrice?: string; sortOrder?: number } = {},
  ) =>
    prisma.$executeRaw`INSERT INTO products (id, tenant_id, category_id, name, description, code, base_price, sort_order, status, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${v.categoryId ?? null}::uuid, ${v.name ?? "Suco"}, ${v.description ?? null},
              ${v.code ?? null}, ${v.basePrice ?? "8.00"}::numeric, ${v.sortOrder ?? 0}, 'ACTIVE', now())`;

  const insertGroup = (tenantId: string, productId: string, v: { name?: string; min?: number; max?: number; sortOrder?: number } = {}) =>
    prisma.$executeRaw`INSERT INTO product_option_groups (id, tenant_id, product_id, name, min_choices, max_choices, sort_order, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${productId}::uuid, ${v.name ?? "Extras"}, ${v.min ?? 0}, ${v.max ?? 1}, ${v.sortOrder ?? 1}, now())`;

  const insertOption = (
    tenantId: string,
    productId: string,
    groupId: string,
    v: { name?: string; priceDelta?: string; linkedProductId?: string | null; sortOrder?: number } = {},
  ) =>
    prisma.$executeRaw`INSERT INTO product_options (id, tenant_id, product_id, group_id, name, price_delta, linked_product_id, sort_order, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${productId}::uuid, ${groupId}::uuid, ${v.name ?? "Bacon"},
              ${v.priceDelta ?? "4.00"}::numeric, ${v.linkedProductId ?? null}::uuid, ${v.sortOrder ?? 1}, now())`;

  const insertSetting = (tenantId: string, branchId: string, productId: string, price: string | null = "9.90") =>
    prisma.$executeRaw`INSERT INTO branch_product_settings (id, tenant_id, branch_id, product_id, available, price, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${branchId}::uuid, ${productId}::uuid, true, ${price}::numeric, now())`;

  describe("columns", () => {
    it("stores money as numeric(12,2), ids as uuid and timestamps as timestamptz(3)", async () => {
      const rows = await prisma.$queryRaw<{ column: string; type: string; nullable: boolean }[]>`
        SELECT c.relname || '.' || a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY(${[...M4_TABLES]}::text[]) AND a.attnum > 0 AND NOT a.attisdropped`;
      const byColumn = Object.fromEntries(rows.map((r) => [r.column, `${r.type}${r.nullable ? " NULL" : ""}`]));
      expect(byColumn).toEqual({
        "product_categories.id": "uuid",
        "product_categories.tenant_id": "uuid",
        "product_categories.name": "text",
        "product_categories.sort_order": "integer",
        "product_categories.status": "product_category_status",
        "product_categories.created_at": "timestamp(3) with time zone",
        "product_categories.updated_at": "timestamp(3) with time zone",
        "products.id": "uuid",
        "products.kitchen_sector_id": "uuid NULL",
        "products.tenant_id": "uuid",
        "products.category_id": "uuid NULL",
        "products.name": "text",
        "products.description": "text NULL",
        "products.code": "text NULL",
        "products.base_price": "numeric(12,2)",
        "products.sort_order": "integer",
        "products.status": "product_status",
        "products.created_at": "timestamp(3) with time zone",
        "products.updated_at": "timestamp(3) with time zone",
        "product_option_groups.id": "uuid",
        "product_option_groups.tenant_id": "uuid",
        "product_option_groups.product_id": "uuid",
        "product_option_groups.name": "text",
        "product_option_groups.min_choices": "integer",
        "product_option_groups.max_choices": "integer",
        "product_option_groups.sort_order": "integer",
        "product_option_groups.created_at": "timestamp(3) with time zone",
        "product_option_groups.updated_at": "timestamp(3) with time zone",
        "product_options.id": "uuid",
        "product_options.tenant_id": "uuid",
        "product_options.product_id": "uuid",
        "product_options.group_id": "uuid",
        "product_options.name": "text",
        "product_options.price_delta": "numeric(12,2)",
        "product_options.linked_product_id": "uuid NULL",
        "product_options.sort_order": "integer",
        "product_options.created_at": "timestamp(3) with time zone",
        "product_options.updated_at": "timestamp(3) with time zone",
        "branch_product_settings.id": "uuid",
        "branch_product_settings.tenant_id": "uuid",
        "branch_product_settings.branch_id": "uuid",
        "branch_product_settings.product_id": "uuid",
        "branch_product_settings.available": "boolean",
        "branch_product_settings.price": "numeric(12,2) NULL",
        "branch_product_settings.created_at": "timestamp(3) with time zone",
        "branch_product_settings.updated_at": "timestamp(3) with time zone",
      });
    });

    it("creates both status enums with exactly ACTIVE and INACTIVE", async () => {
      const rows = await prisma.$queryRaw<{ type: string; labels: string[] }[]>`
        SELECT t.typname::text AS type, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('product_status', 'product_category_status') GROUP BY t.typname`;
      expect(Object.fromEntries(rows.map((r) => [r.type, r.labels]))).toEqual({
        product_status: ["ACTIVE", "INACTIVE"],
        product_category_status: ["ACTIVE", "INACTIVE"],
      });
    });

    it("generates UUIDv7 ids and keeps money exact (no float)", async () => {
      const c = await newCatalog();
      for (const id of [c.categoryId, c.productId, c.groupId, c.optionId]) expect(id).toMatch(UUID_V7);
      const a = await prisma.product.create({ data: { tenantId: c.tenantId, name: "A", basePrice: "0.10", status: ProductStatus.ACTIVE } });
      const b = await prisma.product.create({ data: { tenantId: c.tenantId, name: "B", basePrice: "0.20", status: ProductStatus.ACTIVE } });
      const [row] = await prisma.$queryRaw<{ sum: string }[]>`
        SELECT (SELECT base_price FROM products WHERE id = ${a.id}::uuid) + (SELECT base_price FROM products WHERE id = ${b.id}::uuid) AS sum`;
      expect(String(row?.sum)).toBe("0.3");
      expect(a.basePrice.plus(b.basePrice).toFixed(2)).toBe("0.30");
      const max = await prisma.product.create({ data: { tenantId: c.tenantId, name: "Max", basePrice: "9999999999.99", status: ProductStatus.ACTIVE } });
      expect(max.basePrice.toFixed(2)).toBe("9999999999.99");
      // numeric(12,2): an 11th integer digit overflows instead of losing precision.
      await expect(insertProduct(c.tenantId, { basePrice: "10000000000.00" })).rejects.toThrow(/numeric field overflow/);
    });
  });

  describe("CHECK constraints", () => {
    it.each([
      ["blank name", { name: "  " }, "product_categories_name_check"],
      ["negative sort_order", { sortOrder: -1 }, "product_categories_sort_order_check"],
      ["sort_order above 9999", { sortOrder: 10000 }, "product_categories_sort_order_check"],
    ])("product_categories rejects %s", async (_, values, constraint) => {
      const c = await newCatalog();
      await expect(insertCategory(c, values)).rejects.toThrow(new RegExp(constraint));
    });

    it.each([
      ["blank name", { name: " " }, "products_name_check"],
      ["blank description", { description: "  " }, "products_description_check"],
      ["lowercase code", { code: "xb" }, "products_code_check"],
      ["code starting with a dash", { code: "-XB" }, "products_code_check"],
      ["code with a space", { code: "X B" }, "products_code_check"],
      ["code longer than 32", { code: "X".repeat(33) }, "products_code_check"],
      ["negative base_price", { basePrice: "-0.01" }, "products_base_price_check"],
      ["sort_order above 9999", { sortOrder: 10000 }, "products_sort_order_check"],
    ])("products rejects %s", async (_, values, constraint) => {
      const c = await newCatalog();
      await expect(insertProduct(c.tenantId, values)).rejects.toThrow(new RegExp(constraint));
    });

    it("products accepts NULL description/code/category and the boundary values", async () => {
      const c = await newCatalog();
      expect(await insertProduct(c.tenantId, { basePrice: "0", sortOrder: 9999, code: "A" })).toBe(1);
      expect(await insertProduct(c.tenantId, { code: `${"Z".repeat(31)}_`, sortOrder: 0 })).toBe(1);
      expect(await insertProduct(c.tenantId)).toBe(1);
    });

    it.each([
      ["blank name", { name: "" }, "product_option_groups_name_check"],
      ["negative min_choices", { min: -1, max: 1 }, "product_option_groups_min_choices_check"],
      ["max_choices 0", { min: 0, max: 0 }, "product_option_groups_max_choices_check"],
      ["min greater than max", { min: 3, max: 2 }, "product_option_groups_choices_check"],
      ["sort_order above 9999", { sortOrder: 10000 }, "product_option_groups_sort_order_check"],
    ])("product_option_groups rejects %s", async (_, values, constraint) => {
      const c = await newCatalog();
      await expect(insertGroup(c.tenantId, c.productId, values)).rejects.toThrow(new RegExp(constraint));
    });

    it.each([
      ["blank name", { name: " " }, "product_options_name_check"],
      ["negative price_delta", { priceDelta: "-1.00" }, "product_options_price_delta_check"],
      ["sort_order above 9999", { sortOrder: 10000 }, "product_options_sort_order_check"],
    ])("product_options rejects %s", async (_, values, constraint) => {
      const c = await newCatalog();
      await expect(insertOption(c.tenantId, c.productId, c.groupId, values)).rejects.toThrow(new RegExp(constraint));
    });

    it("product_options rejects an option that links its own product (self-combo)", async () => {
      const c = await newCatalog();
      await expect(insertOption(c.tenantId, c.productId, c.groupId, { linkedProductId: c.productId })).rejects.toThrow(
        /product_options_linked_product_check/,
      );
      await expect(
        prisma.productOption.create({
          data: { tenantId: c.tenantId, productId: c.productId, groupId: c.groupId, name: "Eu", priceDelta: "0", linkedProductId: c.productId, sortOrder: 5 },
        }),
      ).rejects.toThrow(/product_options_linked_product_check/);
    });

    it("branch_product_settings rejects a negative price and accepts NULL (= base price)", async () => {
      const c = await newCatalog();
      await expect(insertSetting(c.tenantId, c.branchId, c.productId, "-0.01")).rejects.toThrow(/branch_product_settings_price_check/);
      expect(await insertSetting(c.tenantId, c.branchId, c.productId, null)).toBe(1);
    });
  });

  describe("uniques", () => {
    it("product code is unique per tenant; NULL codes and the same code in another tenant are fine", async () => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      await expect(insertProduct(a.tenantId, { code: "XB" })).rejects.toThrow(/products_tenant_id_code_key/);
      expect(await insertProduct(b.tenantId, { code: "SUCO" })).toBe(1);
      expect(await insertProduct(a.tenantId, { code: "SUCO" })).toBe(1);
      expect(await insertProduct(a.tenantId, { code: null })).toBe(1);
      expect(await insertProduct(a.tenantId, { code: null })).toBe(1);
    });

    it("one setting per (branch, product) and one sort_order per group/option position", async () => {
      const c = await newCatalog();
      expect(await insertSetting(c.tenantId, c.branchId, c.productId)).toBe(1);
      await expect(insertSetting(c.tenantId, c.branchId, c.productId)).rejects.toThrow(/branch_product_settings_tenant_id_branch_id_product_id_key/);
      await expect(insertGroup(c.tenantId, c.productId, { sortOrder: 0 })).rejects.toThrow(/product_option_groups_tenant_id_product_id_sort_order_key/);
      await expect(insertOption(c.tenantId, c.productId, c.groupId, { sortOrder: 0 })).rejects.toThrow(
        /product_options_tenant_id_product_id_group_id_sort_order_key/,
      );
    });
  });

  describe("composite FKs: nothing points across tenants", () => {
    it("rejects a product of tenant A in a category of tenant B", async () => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      await expect(insertProduct(a.tenantId, { categoryId: b.categoryId })).rejects.toThrow(/products_tenant_id_category_id_fkey/);
    });

    it("rejects a group of tenant A on a product of tenant B", async () => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      await expect(insertGroup(a.tenantId, b.productId)).rejects.toThrow(/product_option_groups_tenant_id_product_id_fkey/);
    });

    it("rejects an option on a group of another tenant or of another product", async () => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      await expect(insertOption(a.tenantId, b.productId, b.groupId)).rejects.toThrow(/product_options_tenant_id_product_id_group_id_fkey/);
      // product_id must be the group's product: the copy cannot diverge.
      await expect(insertOption(a.tenantId, a.drinkId, a.groupId)).rejects.toThrow(/product_options_tenant_id_product_id_group_id_fkey/);
    });

    it("rejects a combo option linking a product of another tenant", async () => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      await expect(insertOption(a.tenantId, a.productId, a.groupId, { linkedProductId: b.drinkId })).rejects.toThrow(
        /product_options_tenant_id_linked_product_id_fkey/,
      );
    });

    it("rejects a branch setting pointing to a branch or product of another tenant", async () => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      await expect(insertSetting(a.tenantId, b.branchId, a.productId)).rejects.toThrow(/branch_product_settings_tenant_id_branch_id_fkey/);
      await expect(insertSetting(a.tenantId, a.branchId, b.productId)).rejects.toThrow(/branch_product_settings_tenant_id_product_id_fkey/);
    });

    it("rejects a non-existent tenant", async () => {
      await expect(insertCategory({ tenantId: randomUUID() })).rejects.toThrow(/product_categories_tenant_id_fkey/);
    });
  });

  describe("RESTRICT: no parent disappears under its children", () => {
    it("blocks deleting a category with products, a product with groups/settings/links and a group with options", async () => {
      const c = await newCatalog();
      await insertSetting(c.tenantId, c.branchId, c.drinkId);
      await expect(prisma.$executeRaw`DELETE FROM product_categories WHERE id = ${c.categoryId}::uuid`).rejects.toThrow(
        /products_tenant_id_category_id_fkey/,
      );
      await expect(prisma.$executeRaw`DELETE FROM product_option_groups WHERE id = ${c.groupId}::uuid`).rejects.toThrow(
        /product_options_tenant_id_product_id_group_id_fkey/,
      );
      await expect(prisma.$executeRaw`DELETE FROM products WHERE id = ${c.productId}::uuid`).rejects.toThrow(
        /product_option_groups_tenant_id_product_id_fkey/,
      );
      await expect(prisma.$executeRaw`DELETE FROM products WHERE id = ${c.drinkId}::uuid`).rejects.toThrow(
        /(product_options_tenant_id_linked_product_id_fkey|branch_product_settings_tenant_id_product_id_fkey)/,
      );
      await expect(prisma.$executeRaw`DELETE FROM branches WHERE id = ${c.branchId}::uuid`).rejects.toThrow(
        /branch_product_settings_tenant_id_branch_id_fkey/,
      );
      await expect(prisma.$executeRaw`UPDATE products SET id = gen_random_uuid() WHERE id = ${c.drinkId}::uuid`).rejects.toThrow(/fkey/);
    });

    it("allows the block replacement order: options, then groups", async () => {
      const c = await newCatalog();
      expect(await prisma.productOption.deleteMany({ where: { tenantId: c.tenantId, productId: c.productId } })).toEqual({ count: 1 });
      expect(await prisma.productOptionGroup.deleteMany({ where: { tenantId: c.tenantId, productId: c.productId } })).toEqual({ count: 1 });
    });
  });

  describe("tenant_id is immutable on every M4 table", () => {
    it.each(M4_TABLES)("%s", async (table) => {
      const a = await newCatalog("A");
      const b = await newCatalog("B");
      if (table === "branch_product_settings") await insertSetting(a.tenantId, a.branchId, a.productId);
      const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM "${table}" WHERE tenant_id = $1::uuid LIMIT 1`, a.tenantId);
      await expectTenantIdImmutable(
        prisma.$executeRawUnsafe(`UPDATE "${table}" SET tenant_id = $1::uuid WHERE id = $2::uuid`, b.tenantId, row!.id),
        table,
      );
    });
  });
});
