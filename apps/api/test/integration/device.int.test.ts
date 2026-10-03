import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  DeviceStatus,
  DeviceType,
  TenantStatus,
  type Branch,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const BRANCH_FK = /devices_tenant_id_branch_id_fkey/;

interface Org {
  tenantId: string;
  branch: Branch;
  otherBranch: Branch;
}

describe("Device (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant with one company and two branches. */
  async function newOrg(name = "Tenant"): Promise<Org> {
    const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    const company = await prisma.company.create({
      data: {
        tenantId: tenant.id,
        legalName: `${name} Ltda`,
        tradeName: name,
        cnpj: "11222333000181",
        status: CompanyStatus.ACTIVE,
        timezone: "America/Sao_Paulo",
      },
    });
    const branch = (code: string) =>
      prisma.branch.create({
        data: { tenantId: tenant.id, companyId: company.id, name: code, code, status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
      });
    return { tenantId: tenant.id, branch: await branch("MORUMBI"), otherBranch: await branch("ELDORADO") };
  }

  type DeviceInput = Partial<{
    branchId: string | null;
    name: string;
    deviceType: DeviceType;
    deviceKey: string;
    status: DeviceStatus;
    lastSeenAt: Date | null;
  }>;

  function newDevice(tenantId: string, overrides: DeviceInput = {}) {
    return prisma.device.create({
      data: {
        tenantId,
        name: "PDV Caixa 1",
        deviceType: DeviceType.POS,
        deviceKey: "pos-001",
        status: DeviceStatus.ACTIVE,
        ...overrides,
      },
    });
  }

  /** Raw insert bypassing Prisma validation. */
  function rawInsert(values: {
    tenantId: string;
    branchId?: string | null;
    name?: string;
    deviceType?: string;
    deviceKey?: string;
    status?: string;
  }) {
    const { tenantId, branchId = null, name = "PDV Caixa 1", deviceType = "POS", deviceKey = "pos-001", status = "ACTIVE" } =
      values;
    return prisma.$executeRaw`
      INSERT INTO devices (id, tenant_id, branch_id, name, device_type, device_key, status, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${branchId}::uuid, ${name}, ${deviceType}::device_type,
              ${deviceKey}, ${status}::device_status, now())`;
  }

  describe("creation, tenant and branch", () => {
    it("creates a valid device", async () => {
      const org = await newOrg();
      const device = await newDevice(org.tenantId, { branchId: org.branch.id });

      expect(await prisma.device.findUnique({ where: { id: device.id } })).toEqual(device);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const org = await newOrg();
      const before = Date.now();
      const device = await newDevice(org.tenantId);
      const after = Date.now();

      expect(device.id).toMatch(UUID_V7);
      expect(uuidV7Millis(device.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(device.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM devices WHERE id = ${device.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("links the device to its tenant (Tenant 1 -> N Device)", async () => {
      const org = await newOrg();
      const a = await newDevice(org.tenantId, { deviceKey: "pos-001" });
      const b = await newDevice(org.tenantId, { deviceKey: "pos-002" });

      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: org.tenantId },
        include: { devices: { orderBy: { deviceKey: "asc" } } },
      });
      expect(tenant.devices.map((d) => d.id)).toEqual([a.id, b.id]);
    });

    it("rejects a non-existent tenant", async () => {
      await expect(newDevice(randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: randomUUID() })).rejects.toThrow(/devices_tenant_id_fkey/);
    });

    it("accepts a tenant-level device (branch_id NULL; MATCH SIMPLE skips the branch FK)", async () => {
      const org = await newOrg();
      const device = await newDevice(org.tenantId, { branchId: null, deviceType: DeviceType.ADMIN });
      await rawInsert({ tenantId: org.tenantId, deviceKey: "admin-raw", branchId: null });

      expect(device.branchId).toBeNull();
      expect(await prisma.device.count({ where: { tenantId: org.tenantId, branchId: null } })).toBe(2);
    });

    it("accepts a device in a branch of the same tenant", async () => {
      const org = await newOrg();
      const device = await newDevice(org.tenantId, { branchId: org.branch.id });

      const loaded = await prisma.device.findUniqueOrThrow({ where: { id: device.id }, include: { branch: true } });
      expect(loaded.branch?.id).toBe(org.branch.id);
      expect(loaded.branch?.tenantId).toBe(loaded.tenantId);
    });

    it("rejects a branch of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(newDevice(a.tenantId, { branchId: b.branch.id })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: a.tenantId, branchId: b.branch.id })).rejects.toThrow(BRANCH_FK);
    });

    it("rejects a non-existent branch", async () => {
      const org = await newOrg();

      await expect(newDevice(org.tenantId, { branchId: randomUUID() })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: org.tenantId, branchId: randomUUID() })).rejects.toThrow(BRANCH_FK);
    });
  });

  describe("name and device_key", () => {
    it("persists name and device_key exactly", async () => {
      const org = await newOrg();
      const device = await newDevice(org.tenantId, { name: "Display Cozinha — Chapa", deviceKey: "KDS:morumbi/01" });

      const [row] = await prisma.$queryRaw<{ name: string; deviceKey: string }[]>`
        SELECT name, device_key AS "deviceKey" FROM devices WHERE id = ${device.id}::uuid`;
      expect(row).toEqual({ name: "Display Cozinha — Chapa", deviceKey: "KDS:morumbi/01" });
    });

    it.each([
      ["name", ""],
      ["name", "   "],
      ["deviceKey", ""],
      ["deviceKey", "   "],
    ])("rejects %s = %j", async (field, value) => {
      const org = await newOrg();
      const constraint = field === "name" ? /devices_name_check/ : /devices_device_key_check/;

      await expect(rawInsert({ tenantId: org.tenantId, [field]: value })).rejects.toThrow(constraint);
      await expect(newDevice(org.tenantId, { [field]: value })).rejects.toThrow(constraint);
    });

    it("rejects a duplicate device_key in the same tenant, even in another branch", async () => {
      const org = await newOrg();
      await newDevice(org.tenantId, { deviceKey: "pos-001", branchId: org.branch.id });

      await expect(newDevice(org.tenantId, { deviceKey: "pos-001", branchId: org.otherBranch.id })).rejects.toMatchObject({
        code: "P2002",
      });
      await expect(rawInsert({ tenantId: org.tenantId, deviceKey: "pos-001" })).rejects.toThrow(
        /devices_tenant_id_device_key_key/,
      );
    });

    it("accepts the same device_key in different tenants", async () => {
      const a = await newDevice((await newOrg("A")).tenantId, { deviceKey: "pos-001" });
      const b = await newDevice((await newOrg("B")).tenantId, { deviceKey: "pos-001" });

      expect(a.deviceKey).toBe(b.deviceKey);
      expect(a.tenantId).not.toBe(b.tenantId);
    });
  });

  describe("device_type and status", () => {
    it.each(Object.values(DeviceType))("persists device_type %s", async (deviceType) => {
      const device = await newDevice((await newOrg()).tenantId, { deviceType });

      const [row] = await prisma.$queryRaw<{ deviceType: string }[]>`
        SELECT device_type::text AS "deviceType" FROM devices WHERE id = ${device.id}::uuid`;
      expect(row?.deviceType).toBe(deviceType);
    });

    it("only knows the approved device types", () => {
      expect(Object.values(DeviceType)).toEqual(["POS", "TABLET", "ADMIN", "KITCHEN_DISPLAY", "EDGE"]);
    });

    it("rejects an invalid device_type", async () => {
      const org = await newOrg();

      for (const invalid of ["PRINTER", "pos", "KDS", ""]) {
        await expect(rawInsert({ tenantId: org.tenantId, deviceType: invalid })).rejects.toThrow(
          /invalid input value for enum device_type/,
        );
      }
      await expect(newDevice(org.tenantId, { deviceType: "PRINTER" as DeviceType })).rejects.toThrow();
    });

    it.each(Object.values(DeviceStatus))("persists status %s", async (status) => {
      const device = await newDevice((await newOrg()).tenantId, { status });

      const [row] = await prisma.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM devices WHERE id = ${device.id}::uuid`;
      expect(row?.status).toBe(status);
    });

    it("only knows ACTIVE, INACTIVE and REVOKED", () => {
      expect(Object.values(DeviceStatus)).toEqual(["ACTIVE", "INACTIVE", "REVOKED"]);
    });

    it("rejects an invalid status", async () => {
      const org = await newOrg();

      for (const invalid of ["DISABLED", "PAIRED", "active", ""]) {
        await expect(rawInsert({ tenantId: org.tenantId, status: invalid })).rejects.toThrow(
          /invalid input value for enum device_status/,
        );
      }
      await expect(newDevice(org.tenantId, { status: "PAIRED" as DeviceStatus })).rejects.toThrow();
      expect(await prisma.device.count({ where: { tenantId: org.tenantId } })).toBe(0);
    });
  });

  describe("dates", () => {
    it("accepts a null last_seen_at", async () => {
      const device = await newDevice((await newOrg()).tenantId);

      expect(device.lastSeenAt).toBeNull();
      const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
        SELECT last_seen_at IS NULL AS "isNull" FROM devices WHERE id = ${device.id}::uuid`;
      expect(row?.isNull).toBe(true);
    });

    it("persists last_seen_at as a UTC instant", async () => {
      const lastSeenAt = new Date("2026-10-02T23:59:58.123Z");
      const device = await newDevice((await newOrg()).tenantId, { lastSeenAt });

      const [row] = await prisma.$queryRaw<{ lastSeenUtc: string }[]>`
        SELECT to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenUtc"
        FROM devices WHERE id = ${device.id}::uuid`;
      expect(row?.lastSeenUtc).toBe(lastSeenAt.toISOString());
      expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).lastSeenAt?.toISOString()).toBe(
        lastSeenAt.toISOString(),
      );
    });

    it("stores created_at as a correct UTC instant", async () => {
      const skewMs = 5_000; // tolerance between test-runner and database clocks
      const before = Date.now();
      const device = await newDevice((await newOrg()).tenantId);

      expect(device.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
      expect(device.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + skewMs);
      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM devices WHERE id = ${device.id}::uuid`;
      expect(row?.createdAt).toEqual(device.createdAt);
      expect(row?.driftSeconds).toBeLessThan(skewMs / 1000);
      expect(row?.createdUtc).toBe(device.createdAt.toISOString());
    });

    it("refreshes updated_at on update and keeps created_at", async () => {
      const device = await newDevice((await newOrg()).tenantId);
      await new Promise((r) => setTimeout(r, 20));

      const updated = await prisma.device.update({ where: { id: device.id }, data: { status: DeviceStatus.REVOKED } });

      expect(updated.createdAt).toEqual(device.createdAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(device.updatedAt.getTime());
    });
  });

  describe("multi-tenant isolation on update", () => {
    it("rejects changing branch_id to a branch of another tenant, including from NULL (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const inBranch = await newDevice(a.tenantId, { deviceKey: "pos-001", branchId: a.branch.id });
      const tenantLevel = await newDevice(a.tenantId, { deviceKey: "admin-001", branchId: null });

      for (const { id } of [inBranch, tenantLevel]) {
        await expect(prisma.device.update({ where: { id }, data: { branchId: b.branch.id } })).rejects.toMatchObject({
          code: "P2003",
        });
        await expect(
          prisma.$executeRaw`UPDATE devices SET branch_id = ${b.branch.id}::uuid WHERE id = ${id}::uuid`,
        ).rejects.toThrow(BRANCH_FK);
      }
    });

    it("rejects changing only tenant_id when a branch is linked (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const device = await newDevice(a.tenantId, { branchId: a.branch.id });

      await expect(prisma.device.update({ where: { id: device.id }, data: { tenantId: b.tenantId } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.$executeRaw`UPDATE devices SET tenant_id = ${b.tenantId}::uuid WHERE id = ${device.id}::uuid`,
      ).rejects.toThrow(BRANCH_FK);
    });

    it("blocks moving a branch that has devices to another tenant, even consistently with its company", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      await newDevice(a.tenantId, { branchId: a.branch.id });

      await expect(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${b.tenantId}::uuid, company_id = ${b.branch.companyId}::uuid,
                                               code = 'X-1'
                           WHERE id = ${a.branch.id}::uuid`,
      ).rejects.toThrow(BRANCH_FK);
    });

    // tenant_id is conceptually immutable; the schema cannot forbid a consistent move.
    it("GAP (M1.14): accepts moving a tenant-level device (branch_id NULL) to another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const device = await newDevice(a.tenantId, { branchId: null });

      const moved = await prisma.device.update({ where: { id: device.id }, data: { tenantId: b.tenantId } });

      expect(moved.tenantId).toBe(b.tenantId);
    });

    it("GAP (M1.14): accepts moving a device when tenant_id and branch_id change together", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const device = await newDevice(a.tenantId, { branchId: a.branch.id });

      const moved = await prisma.device.update({
        where: { id: device.id },
        data: { tenantId: b.tenantId, branchId: b.branch.id },
      });

      expect(moved).toMatchObject({ tenantId: b.tenantId, branchId: b.branch.id });
    });

    it("has no device in the database linked to a branch of another tenant", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM devices d JOIN branches b ON b.id = d.branch_id
        WHERE b.tenant_id <> d.tenant_id`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a branch that has a device", async () => {
      const org = await newOrg();
      const device = await newDevice(org.tenantId, { branchId: org.branch.id });

      await expect(prisma.branch.delete({ where: { id: org.branch.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM branches WHERE id = ${org.branch.id}::uuid`).rejects.toThrow(BRANCH_FK);
      expect(await prisma.device.findUnique({ where: { id: device.id } })).not.toBeNull();
    });

    it("refuses to delete a tenant that has a device", async () => {
      const org = await newOrg();
      const device = await newDevice(org.tenantId, { branchId: null });

      await expect(prisma.tenant.delete({ where: { id: org.tenantId } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${org.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.device.findUnique({ where: { id: device.id } })).not.toBeNull();
    });
  });

  describe("structural security", () => {
    it("has no secret-like column in devices (device_key is an identifier, not a secret)", async () => {
      const columns = await prisma.$queryRaw<{ name: string }[]>`
        SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'devices' ORDER BY ordinal_position`;
      const names = columns.map((c) => c.name);

      expect(names).toEqual([
        "id",
        "tenant_id",
        "branch_id",
        "name",
        "device_type",
        "device_key",
        "status",
        "last_seen_at",
        "created_at",
        "updated_at",
      ]);
      const forbidden = /(secret|api_key|private_key|access_token|refresh_token|token|password|passwd|pin|certificate)/i;
      expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    });
  });
});
