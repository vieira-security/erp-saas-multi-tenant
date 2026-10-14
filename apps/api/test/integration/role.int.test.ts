import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RoleStatus, TenantStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

// Default role codes (docs/database.md); provisioning per tenant is future work, not a seed.
const DEFAULT_ROLES = [
  { code: "OWNER", name: "Proprietário" },
  { code: "MANAGER", name: "Gerente" },
  { code: "ATTENDANT", name: "Atendente" },
  { code: "KITCHEN", name: "Cozinha" },
];

describe("Role (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function newTenant(name = "Tenant") {
    return prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
  }

  type RoleInput = Partial<{ code: string; name: string; description: string | null; isSystem: boolean; status: RoleStatus }>;

  function newRole(tenantId: string, overrides: RoleInput = {}) {
    return prisma.role.create({
      data: { tenantId, code: "MANAGER", name: "Gerente", status: RoleStatus.ACTIVE, ...overrides },
    });
  }

  /** Raw insert bypassing Prisma validation, relying on database defaults for the remaining columns. */
  function rawInsert(values: { tenantId: string; code?: string; name?: string; status?: string }) {
    const { tenantId, code = "MANAGER", name = "Gerente", status = "ACTIVE" } = values;
    return prisma.$executeRaw`
      INSERT INTO roles (id, tenant_id, code, name, status, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${code}, ${name}, ${status}::role_status, now())`;
  }

  describe("creation and tenant", () => {
    it("creates a valid role", async () => {
      const role = await newRole((await newTenant()).id);

      expect(await prisma.role.findUnique({ where: { id: role.id } })).toEqual(role);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const tenant = await newTenant();
      const before = Date.now();
      const role = await newRole(tenant.id);
      const after = Date.now();

      expect(role.id).toMatch(UUID_V7);
      expect(uuidV7Millis(role.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(role.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("links the role to its tenant and supports the four default codes per tenant", async () => {
      const tenant = await newTenant();
      for (const role of DEFAULT_ROLES) await newRole(tenant.id, { ...role, isSystem: true });

      const withRoles = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        include: { roles: { orderBy: { code: "asc" } } },
      });
      expect(withRoles.roles.map((r) => r.code)).toEqual(["ATTENDANT", "KITCHEN", "MANAGER", "OWNER"]);
      expect(withRoles.roles.every((r) => r.tenantId === tenant.id && r.isSystem)).toBe(true);
    });

    it("rejects a non-existent tenant", async () => {
      await expect(newRole(randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: randomUUID() })).rejects.toThrow(/roles_tenant_id_fkey/);
    });
  });

  describe("code", () => {
    it("persists the code exactly, without forcing uppercase", async () => {
      const tenant = await newTenant();
      await newRole(tenant.id, { code: "OWNER" });
      const custom = await newRole(tenant.id, { code: "caixa-noturno", name: "Caixa noturno" });

      const rows = await prisma.$queryRaw<{ code: string }[]>`
        SELECT code FROM roles WHERE tenant_id = ${tenant.id}::uuid ORDER BY code`;
      expect(rows.map((r) => r.code)).toEqual(["OWNER", "caixa-noturno"]);
      expect(custom.code).toBe("caixa-noturno");
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects a code that is %s", async (_, code) => {
      const tenant = await newTenant();

      await expect(rawInsert({ tenantId: tenant.id, code })).rejects.toThrow(/roles_code_check/);
      await expect(newRole(tenant.id, { code })).rejects.toThrow(/roles_code_check/);
    });

    it("rejects a duplicate code in the same tenant", async () => {
      const tenant = await newTenant();
      await newRole(tenant.id, { code: "OWNER" });

      await expect(newRole(tenant.id, { code: "OWNER", name: "Outro" })).rejects.toMatchObject({ code: "P2002" });
      await expect(rawInsert({ tenantId: tenant.id, code: "OWNER" })).rejects.toThrow(/roles_tenant_id_code_key/);
    });

    it("accepts the same code in different tenants", async () => {
      const a = await newRole((await newTenant("A")).id, { code: "OWNER" });
      const b = await newRole((await newTenant("B")).id, { code: "OWNER" });

      expect(a.code).toBe(b.code);
      expect(a.tenantId).not.toBe(b.tenantId);
    });
  });

  describe("name and description", () => {
    it("persists the name exactly", async () => {
      const role = await newRole((await newTenant()).id, { code: "OWNER", name: "Proprietário" });

      const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT name FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.name).toBe("Proprietário");
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects a name that is %s", async (_, name) => {
      const tenant = await newTenant();

      await expect(rawInsert({ tenantId: tenant.id, name })).rejects.toThrow(/roles_name_check/);
      await expect(newRole(tenant.id, { name })).rejects.toThrow(/roles_name_check/);
    });

    it("accepts a null description", async () => {
      const role = await newRole((await newTenant()).id);

      expect(role.description).toBeNull();
      const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
        SELECT description IS NULL AS "isNull" FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.isNull).toBe(true);
    });

    it("accepts a description text", async () => {
      const description = "Prepara pedidos e marca itens como prontos na cozinha.";
      const role = await newRole((await newTenant()).id, { code: "KITCHEN", name: "Cozinha", description });

      const [row] = await prisma.$queryRaw<{ description: string }[]>`
        SELECT description FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.description).toBe(description);
    });
  });

  describe("is_system", () => {
    it("defaults to false (Prisma and database)", async () => {
      const tenant = await newTenant();
      const role = await newRole(tenant.id, { code: "CUSTOM_A" });
      await rawInsert({ tenantId: tenant.id, code: "CUSTOM_B" });

      expect(role.isSystem).toBe(false);
      const [row] = await prisma.$queryRaw<{ isSystem: boolean }[]>`
        SELECT is_system AS "isSystem" FROM roles WHERE tenant_id = ${tenant.id}::uuid AND code = 'CUSTOM_B'`;
      expect(row?.isSystem).toBe(false);
    });

    it("accepts true", async () => {
      const role = await newRole((await newTenant()).id, { code: "OWNER", name: "Proprietário", isSystem: true });

      const [row] = await prisma.$queryRaw<{ isSystem: boolean }[]>`
        SELECT is_system AS "isSystem" FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.isSystem).toBe(true);
    });
  });

  describe("status", () => {
    it.each(Object.values(RoleStatus))("persists status %s", async (status) => {
      const role = await newRole((await newTenant()).id, { status });

      const [row] = await prisma.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.status).toBe(status);
    });

    it("only knows ACTIVE, INACTIVE and ARCHIVED", () => {
      expect(Object.values(RoleStatus)).toEqual(["ACTIVE", "INACTIVE", "ARCHIVED"]);
    });

    it("rejects an invalid status", async () => {
      const tenant = await newTenant();

      for (const invalid of ["DELETED", "DISABLED", "active", ""]) {
        await expect(rawInsert({ tenantId: tenant.id, status: invalid })).rejects.toThrow(
          /invalid input value for enum role_status/,
        );
      }
      await expect(newRole(tenant.id, { status: "DELETED" as RoleStatus })).rejects.toThrow();
      expect(await prisma.role.count({ where: { tenantId: tenant.id } })).toBe(0);
    });
  });

  describe("timestamps", () => {
    it("stores created_at/updated_at as correct UTC instants", async () => {
      const skewMs = 5_000; // tolerance between test-runner and database clocks
      const before = Date.now();
      const role = await newRole((await newTenant()).id);

      expect(role.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
      expect(role.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + skewMs);

      // Compared with the database clock: a session time-zone shift would show up as hours of drift.
      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM roles WHERE id = ${role.id}::uuid`;
      expect(row?.createdAt).toEqual(role.createdAt);
      expect(row?.driftSeconds).toBeLessThan(skewMs / 1000);
      expect(row?.createdUtc).toBe(role.createdAt.toISOString());
    });

    it("refreshes updated_at on update and keeps created_at", async () => {
      const role = await newRole((await newTenant()).id);
      await new Promise((r) => setTimeout(r, 20));

      const updated = await prisma.role.update({ where: { id: role.id }, data: { status: RoleStatus.ARCHIVED } });

      expect(updated.createdAt).toEqual(role.createdAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(role.updatedAt.getTime());
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a tenant that has a role", async () => {
      const tenant = await newTenant();
      const role = await newRole(tenant.id);

      await expect(prisma.tenant.delete({ where: { id: tenant.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenant.id}::uuid`).rejects.toThrow(
        /roles_tenant_id_fkey/,
      );
      expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
    });
  });
});
