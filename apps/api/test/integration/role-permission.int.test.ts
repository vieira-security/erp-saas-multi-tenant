import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  RoleStatus,
  TenantStatus,
  type Permission,
  type PrismaClient,
  type Role,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const ROLE_FK = /role_permissions_tenant_id_role_id_fkey/;
const PERMISSION_FK = /role_permissions_permission_id_fkey/;

describe("RolePermission (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newRole(tenantName = "Tenant", code = "MANAGER"): Promise<Role> {
    const tenant = await prisma.tenant.create({ data: { name: tenantName, status: TenantStatus.ACTIVE } });
    return addRole(tenant.id, code);
  }

  function addRole(tenantId: string, code: string) {
    return prisma.role.create({ data: { tenantId, code, name: code, status: RoleStatus.ACTIVE } });
  }

  /** Global permission with a unique code (the permissions table is shared by concurrent test files). */
  function newPermission(): Promise<Permission> {
    const module = `t${randomBytes(4).toString("hex")}`;
    return prisma.permission.create({ data: { code: `${module}.read`, module, description: "Permissão de teste" } });
  }

  function link(tenantId: string, roleId: string, permissionId: string) {
    return prisma.rolePermission.create({ data: { tenantId, roleId, permissionId } });
  }

  function rawLink(tenantId: string, roleId: string, permissionId: string) {
    return prisma.$executeRaw`
      INSERT INTO role_permissions (id, tenant_id, role_id, permission_id)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${roleId}::uuid, ${permissionId}::uuid)`;
  }

  describe("creation", () => {
    it("creates a valid role-permission with the right tenant, role and permission", async () => {
      const role = await newRole();
      const permission = await newPermission();
      const created = await link(role.tenantId, role.id, permission.id);

      const loaded = await prisma.rolePermission.findUniqueOrThrow({
        where: { id: created.id },
        include: { tenant: true, role: true, permission: true },
      });
      expect([loaded.tenant.id, loaded.role.id, loaded.permission.id]).toEqual([role.tenantId, role.id, permission.id]);
      expect(loaded.role.tenantId).toBe(loaded.tenantId);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const role = await newRole();
      const permission = await newPermission();
      const before = Date.now();
      const created = await link(role.tenantId, role.id, permission.id);
      const after = Date.now();

      expect(created.id).toMatch(UUID_V7);
      expect(uuidV7Millis(created.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(created.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM role_permissions WHERE id = ${created.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("persists created_at as a correct UTC instant and has no updated_at", async () => {
      const role = await newRole();
      const created = await link(role.tenantId, role.id, (await newPermission()).id);

      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM role_permissions WHERE id = ${created.id}::uuid`;
      expect(row?.createdAt).toEqual(created.createdAt);
      expect(row?.driftSeconds).toBeLessThan(5);
      expect(row?.createdUtc).toBe(created.createdAt.toISOString());

      const [updatedAt] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'role_permissions' AND column_name = 'updated_at'`;
      expect(updatedAt?.count).toBe(0n);
    });

    it("rejects a non-existent tenant", async () => {
      const role = await newRole();
      const permission = await newPermission();

      await expect(link(randomUUID(), role.id, permission.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawLink(randomUUID(), role.id, permission.id)).rejects.toThrow(
        /role_permissions_tenant_id(_role_id)?_fkey/,
      );
    });

    it("rejects a non-existent role", async () => {
      const role = await newRole();
      const permission = await newPermission();

      await expect(link(role.tenantId, randomUUID(), permission.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawLink(role.tenantId, randomUUID(), permission.id)).rejects.toThrow(ROLE_FK);
    });

    it("rejects a non-existent permission", async () => {
      const role = await newRole();

      await expect(link(role.tenantId, role.id, randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawLink(role.tenantId, role.id, randomUUID())).rejects.toThrow(PERMISSION_FK);
    });
  });

  describe("multi-tenant isolation", () => {
    it("rejects a role of another tenant (Prisma and SQL)", async () => {
      const roleA = await newRole("A");
      const roleB = await newRole("B");
      const permission = await newPermission();

      await expect(link(roleA.tenantId, roleB.id, permission.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawLink(roleA.tenantId, roleB.id, permission.id)).rejects.toThrow(ROLE_FK);
      expect(await prisma.rolePermission.count({ where: { permissionId: permission.id } })).toBe(0);
    });

    it("lets the same global permission be used by roles of different tenants", async () => {
      const roleA = await newRole("A");
      const roleB = await newRole("B");
      const permission = await newPermission();

      await link(roleA.tenantId, roleA.id, permission.id);
      await link(roleB.tenantId, roleB.id, permission.id);

      const links = await prisma.rolePermission.findMany({ where: { permissionId: permission.id } });
      expect(new Set(links.map((l) => l.tenantId))).toEqual(new Set([roleA.tenantId, roleB.tenantId]));
    });

    it("rejects changing role_id to a role of another tenant (Prisma and SQL)", async () => {
      const roleA = await newRole("A");
      const roleB = await newRole("B");
      const created = await link(roleA.tenantId, roleA.id, (await newPermission()).id);

      await expect(
        prisma.rolePermission.update({ where: { id: created.id }, data: { roleId: roleB.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE role_permissions SET role_id = ${roleB.id}::uuid WHERE id = ${created.id}::uuid`,
      ).rejects.toThrow(ROLE_FK);
    });

    it("rejects changing only tenant_id (Prisma and SQL)", async () => {
      const roleA = await newRole("A");
      const roleB = await newRole("B");
      const created = await link(roleA.tenantId, roleA.id, (await newPermission()).id);

      await expect(
        prisma.rolePermission.update({ where: { id: created.id }, data: { tenantId: roleB.tenantId } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE role_permissions SET tenant_id = ${roleB.tenantId}::uuid WHERE id = ${created.id}::uuid`,
      ).rejects.toThrow(ROLE_FK);
    });

    it("has no role-permission in the database whose role belongs to another tenant", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.tenant_id <> rp.tenant_id`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("uniqueness and cardinality", () => {
    it("rejects a duplicate link (Prisma and SQL)", async () => {
      const role = await newRole();
      const permission = await newPermission();
      await link(role.tenantId, role.id, permission.id);

      await expect(link(role.tenantId, role.id, permission.id)).rejects.toMatchObject({ code: "P2002" });
      await expect(rawLink(role.tenantId, role.id, permission.id)).rejects.toThrow(
        /role_permissions_tenant_id_role_id_permission_id_key/,
      );
    });

    it("lets one role have several permissions", async () => {
      const role = await newRole();
      const permissions = [await newPermission(), await newPermission(), await newPermission()];
      for (const p of permissions) await link(role.tenantId, role.id, p.id);

      const loaded = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, include: { permissions: true } });
      expect(loaded.permissions.map((l) => l.permissionId).sort()).toEqual(permissions.map((p) => p.id).sort());
    });

    it("lets one permission be in several roles of the same tenant", async () => {
      const manager = await newRole("T", "MANAGER");
      const owner = await addRole(manager.tenantId, "OWNER");
      const permission = await newPermission();
      await link(manager.tenantId, manager.id, permission.id);
      await link(owner.tenantId, owner.id, permission.id);

      const loaded = await prisma.permission.findUniqueOrThrow({ where: { id: permission.id }, include: { roles: true } });
      expect(loaded.roles.map((l) => l.roleId).sort()).toEqual([manager.id, owner.id].sort());
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a role that has a permission", async () => {
      const role = await newRole();
      await link(role.tenantId, role.id, (await newPermission()).id);

      await expect(prisma.role.delete({ where: { id: role.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM roles WHERE id = ${role.id}::uuid`).rejects.toThrow(ROLE_FK);
      expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
    });

    it("refuses to delete a permission that is linked to a role", async () => {
      const role = await newRole();
      const permission = await newPermission();
      await link(role.tenantId, role.id, permission.id);

      await expect(prisma.permission.delete({ where: { id: permission.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM permissions WHERE id = ${permission.id}::uuid`).rejects.toThrow(
        PERMISSION_FK,
      );
      expect(await prisma.permission.findUnique({ where: { id: permission.id } })).not.toBeNull();
    });

    it("refuses to delete a tenant that has a role-permission", async () => {
      const role = await newRole();
      const created = await link(role.tenantId, role.id, (await newPermission()).id);

      await expect(prisma.tenant.delete({ where: { id: role.tenantId } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${role.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.rolePermission.findUnique({ where: { id: created.id } })).not.toBeNull();
    });
  });
});
