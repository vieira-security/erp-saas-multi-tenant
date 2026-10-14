import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TenantStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { PERMISSION_CATALOG, seedPermissions } from "../../src/database/seed/permissions.js";
import { GLOBAL_TABLES, classifyTable } from "./table-audit.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

/** Unique module prefix per call: permissions is a global table shared by concurrent test files. */
function uniqueModule(): string {
  return `t${randomBytes(4).toString("hex")}`;
}

describe("Permission (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function newPermission(overrides: Partial<{ code: string; module: string; description: string }> = {}) {
    const module = uniqueModule();
    return prisma.permission.create({
      data: { code: `${module}.read`, module, description: "Permissão de teste", ...overrides },
    });
  }

  function rawInsert(values: { code: string; module?: string; description?: string }) {
    const { code, module = "tests", description = "Permissão de teste" } = values;
    return prisma.$executeRaw`
      INSERT INTO permissions (id, code, module, description)
      VALUES (gen_random_uuid(), ${code}, ${module}, ${description})`;
  }

  describe("model", () => {
    it("creates a valid permission", async () => {
      const permission = await newPermission();

      expect(await prisma.permission.findUnique({ where: { id: permission.id } })).toEqual(permission);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const before = Date.now();
      const permission = await newPermission();
      const after = Date.now();

      expect(permission.id).toMatch(UUID_V7);
      expect(uuidV7Millis(permission.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(permission.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM permissions WHERE id = ${permission.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("has no tenant_id, updated_at or status column, and no FK at all", async () => {
      const columns = await prisma.$queryRaw<{ name: string }[]>`
        SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'permissions' ORDER BY column_name`;
      expect(columns.map((c) => c.name)).toEqual(["code", "created_at", "description", "id", "module"]);

      const [fks] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_constraint
        WHERE conrelid = 'public.permissions'::regclass AND contype = 'f'`;
      expect(fks?.count).toBe(0n);
    });

    it("is declared as a global table, not a tenant table", () => {
      expect(GLOBAL_TABLES).toContain("permissions");
      expect(classifyTable("permissions")).toBe("global");
    });

    it("stores created_at as a correct UTC instant", async () => {
      const permission = await newPermission();

      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM permissions WHERE id = ${permission.id}::uuid`;
      expect(row?.createdAt).toEqual(permission.createdAt);
      expect(row?.driftSeconds).toBeLessThan(5);
      expect(row?.createdUtc).toBe(permission.createdAt.toISOString());
    });
  });

  describe("code", () => {
    it("persists the code exactly", async () => {
      const module = uniqueModule();
      const permission = await newPermission({ code: `${module}.item_2.cancel`, module });

      const [row] = await prisma.$queryRaw<{ code: string }[]>`
        SELECT code FROM permissions WHERE id = ${permission.id}::uuid`;
      expect(row?.code).toBe(`${module}.item_2.cancel`);
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
      ["without a dot", "branch"],
      ["uppercase", "Branch.Read"],
      ["with spaces", "branch. read"],
      ["with a hyphen", "branch.read-only"],
      ["starting with a digit", "1branch.read"],
      ["segment starting with a digit", "branch.1read"],
      ["empty segment", "branch..read"],
      ["trailing dot", "branch.read."],
      ["leading dot", ".branch.read"],
      ["non-ASCII", "filiação.ler"],
    ])("rejects a code %s", async (_, code) => {
      await expect(rawInsert({ code })).rejects.toThrow(/permissions_code_check/);
      await expect(newPermission({ code })).rejects.toThrow(/permissions_code_check/);
    });

    it("rejects a duplicate code globally (Prisma and SQL)", async () => {
      const permission = await newPermission();

      await expect(newPermission({ code: permission.code, module: permission.module })).rejects.toMatchObject({
        code: "P2002",
      });
      await expect(rawInsert({ code: permission.code })).rejects.toThrow(/permissions_code_key/);
    });

    it("cannot be scoped per tenant: there is no tenant_id and the code stays unique across tenants", async () => {
      const permission = await newPermission();
      const tenant = await prisma.tenant.create({ data: { name: "Tenant", status: TenantStatus.ACTIVE } });

      await expect(
        prisma.$executeRaw`
          INSERT INTO permissions (id, tenant_id, code, module, description)
          VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${permission.code}, 'x', 'x')`,
      ).rejects.toThrow(/column "tenant_id" of relation "permissions" does not exist/);
      await expect(rawInsert({ code: permission.code })).rejects.toThrow(/permissions_code_key/);
    });
  });

  describe("module and description", () => {
    it("persists module and description exactly", async () => {
      const module = uniqueModule();
      const permission = await newPermission({ module, code: `${module}.manage`, description: "Gerenciar itens — teste" });

      const [row] = await prisma.$queryRaw<{ module: string; description: string }[]>`
        SELECT module, description FROM permissions WHERE id = ${permission.id}::uuid`;
      expect(row).toEqual({ module, description: "Gerenciar itens — teste" });
    });

    it.each([
      ["module", ""],
      ["module", "   "],
      ["description", ""],
      ["description", "   "],
    ])("rejects an empty %s (%j)", async (column, value) => {
      const code = `${uniqueModule()}.read`;
      const constraint = column === "module" ? /permissions_module_check/ : /permissions_description_check/;

      await expect(rawInsert({ code, [column]: value })).rejects.toThrow(constraint);
      await expect(newPermission({ code, [column]: value })).rejects.toThrow(constraint);
    });
  });

  describe("seed", () => {
    const catalogCodes = PERMISSION_CATALOG.map((p) => p.code);

    async function catalogRows() {
      return prisma.permission.findMany({ where: { code: { in: catalogCodes } } });
    }

    it("creates the expected initial catalog", async () => {
      await seedPermissions(prisma);

      const rows = await catalogRows();
      expect(rows).toHaveLength(19);
      expect(Object.fromEntries(rows.map((r) => [r.code, r.module]))).toEqual({
        "organization.read": "organization",
        "organization.manage": "organization",
        "branch.read": "organization",
        "branch.manage": "organization",
        "user.read": "users",
        "user.manage": "users",
        "role.read": "users",
        "role.manage": "users",
        "product.read": "products",
        "product.manage": "products",
        "order.read": "orders",
        "order.create": "orders",
        "order.cancel": "orders",
        "cash.read": "cash",
        "cash.open": "cash",
        "cash.close": "cash",
        "fiscal.read": "fiscal",
        "fiscal.issue": "fiscal",
        "fiscal.cancel": "fiscal",
      });
      expect(new Set(rows.map((r) => r.module))).toEqual(
        new Set(["organization", "users", "products", "orders", "cash", "fiscal"]),
      );
      for (const row of rows) expect(row.description.trim(), row.code).not.toBe("");
    });

    it("is idempotent: running it again keeps rows, ids and data", async () => {
      await seedPermissions(prisma);
      const first = new Map((await catalogRows()).map((r) => [r.code, r]));

      await expect(seedPermissions(prisma)).resolves.toBe(19);
      await expect(seedPermissions(prisma)).resolves.toBe(19);

      const again = await catalogRows();
      expect(again).toHaveLength(19);
      for (const row of again) expect(row, row.code).toEqual(first.get(row.code));
    });

    it("has unique codes in the catalog and in the database", async () => {
      await seedPermissions(prisma);

      expect(new Set(catalogCodes).size).toBe(catalogCodes.length);
      const duplicates = await prisma.$queryRaw<{ code: string }[]>`
        SELECT code FROM permissions GROUP BY code HAVING count(*) > 1`;
      expect(duplicates).toEqual([]);
    });

    it("realigns module/description to the catalog without changing the id", async () => {
      await seedPermissions(prisma);
      const before = await prisma.permission.findUniqueOrThrow({ where: { code: "cash.open" } });
      await prisma.permission.update({ where: { code: "cash.open" }, data: { description: "Texto antigo" } });

      await seedPermissions(prisma);

      const after = await prisma.permission.findUniqueOrThrow({ where: { code: "cash.open" } });
      expect(after).toEqual(before);
    });
  });
});
