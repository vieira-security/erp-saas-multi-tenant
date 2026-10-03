import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  DeviceStatus,
  DeviceType,
  Prisma,
  TenantStatus,
  UserStatus,
  type Branch,
  type Device,
  type PrismaClient,
  type User,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { inRolledBackTransaction } from "./table-audit.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const APPEND_ONLY = /AuditLog is append-only: (UPDATE|DELETE) on audit_logs is not allowed/;
const APPEND_ONLY_UPDATE = /AuditLog is append-only: UPDATE on audit_logs is not allowed/;
const APPEND_ONLY_DELETE = /AuditLog is append-only: DELETE on audit_logs is not allowed/;
const USER_FK = /audit_logs_tenant_id_user_id_fkey/;
const BRANCH_FK = /audit_logs_tenant_id_branch_id_fkey/;
const DEVICE_FK = /audit_logs_tenant_id_device_id_fkey/;
const ACTION_CHECK = /audit_logs_action_check/;
const RESOURCE_TYPE_CHECK = /audit_logs_resource_type_check/;

interface Org {
  tenantId: string;
  user: User;
  branch: Branch;
  device: Device;
}

describe("AuditLog (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant with one user, one branch and one device in that branch. */
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
    const branch = await prisma.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: "F", code: "MORUMBI", status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, name: "Usuário 1001", employeeNumber: "1001", passwordHash: "hash", status: UserStatus.ACTIVE },
    });
    const device = await prisma.device.create({
      data: { tenantId: tenant.id, branchId: branch.id, name: "pos-001", deviceType: DeviceType.POS, deviceKey: "pos-001", status: DeviceStatus.ACTIVE },
    });
    return { tenantId: tenant.id, user, branch, device };
  }

  type AuditLogInput = Partial<{
    userId: string | null;
    branchId: string | null;
    deviceId: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    metadata: Prisma.InputJsonValue | typeof Prisma.DbNull;
    ipAddress: string | null;
  }>;

  function newLog(tenantId: string, overrides: AuditLogInput = {}) {
    return prisma.auditLog.create({
      data: { tenantId, action: "user.created", resourceType: "user", ...overrides },
    });
  }

  function rawInsert(values: {
    tenantId: string;
    userId?: string | null;
    branchId?: string | null;
    deviceId?: string | null;
    action?: string | null;
    resourceType?: string | null;
  }) {
    const { tenantId, userId = null, branchId = null, deviceId = null, action = "user.created", resourceType = "user" } = values;
    return prisma.$executeRaw`
      INSERT INTO audit_logs (id, tenant_id, user_id, branch_id, device_id, action, resource_type)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${userId}::uuid, ${branchId}::uuid, ${deviceId}::uuid, ${action}, ${resourceType})`;
  }

  describe("basics", () => {
    it("creates a system event with only tenant, action and resource_type (no user, branch, device or resource)", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { action: "session.expired_cleanup.ran", resourceType: "session" });

      expect(log).toMatchObject({
        tenantId: org.tenantId,
        userId: null,
        branchId: null,
        deviceId: null,
        resourceId: null,
        metadata: null,
        ipAddress: null,
      });
      const loaded = await prisma.auditLog.findUniqueOrThrow({
        where: { id: log.id },
        include: { tenant: true, user: true, branch: true, device: true },
      });
      expect(loaded.tenant.id).toBe(org.tenantId);
      expect([loaded.user, loaded.branch, loaded.device]).toEqual([null, null, null]);
    });

    it("creates a fully populated event linked to user, branch and device of the same tenant", async () => {
      const org = await newOrg();
      const resourceId = randomUUID();
      const log = await newLog(org.tenantId, {
        userId: org.user.id,
        branchId: org.branch.id,
        deviceId: org.device.id,
        action: "order.cancelled",
        resourceType: "order",
        resourceId,
        metadata: { reason: "cliente desistiu" },
        ipAddress: "203.0.113.10",
      });

      const loaded = await prisma.auditLog.findUniqueOrThrow({
        where: { id: log.id },
        include: { user: true, branch: true, device: true },
      });
      expect([loaded.user?.id, loaded.branch?.id, loaded.device?.id]).toEqual([org.user.id, org.branch.id, org.device.id]);
      expect(loaded).toMatchObject({ resourceId, metadata: { reason: "cliente desistiu" }, ipAddress: "203.0.113.10" });
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const org = await newOrg();
      const before = Date.now();
      const log = await newLog(org.tenantId);
      const after = Date.now();

      expect(log.id).toMatch(UUID_V7);
      expect(uuidV7Millis(log.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(log.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM audit_logs WHERE id = ${log.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("rejects a non-existent tenant", async () => {
      await expect(newLog(randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: randomUUID() })).rejects.toThrow(/audit_logs_tenant_id_fkey/);
    });

    it("requires tenant_id, action and resource_type", async () => {
      const org = await newOrg();

      await expect(
        prisma.$executeRaw`INSERT INTO audit_logs (id, action, resource_type) VALUES (gen_random_uuid(), 'user.created', 'user')`,
      ).rejects.toThrow(/null value in column "tenant_id"/);
      await expect(rawInsert({ tenantId: org.tenantId, action: null })).rejects.toThrow(/null value in column "action"/);
      await expect(rawInsert({ tenantId: org.tenantId, resourceType: null })).rejects.toThrow(
        /null value in column "resource_type"/,
      );
    });

    it("persists created_at as a correct UTC instant", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId);

      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM audit_logs WHERE id = ${log.id}::uuid`;
      expect(row?.createdAt).toEqual(log.createdAt);
      expect(row?.driftSeconds).toBeLessThan(5);
      expect(row?.createdUtc).toBe(log.createdAt.toISOString());
    });
  });

  describe("optional user", () => {
    it("accepts an event without user (MATCH SIMPLE skips the user FK when user_id is NULL)", async () => {
      const org = await newOrg();
      await newLog(org.tenantId, { userId: null, deviceId: org.device.id, action: "device.heartbeat.missed", resourceType: "device" });
      await rawInsert({ tenantId: org.tenantId, userId: null });

      expect(await prisma.auditLog.count({ where: { tenantId: org.tenantId, userId: null } })).toBe(2);
    });

    it("accepts a user of the same tenant", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { userId: org.user.id });

      expect(log.userId).toBe(org.user.id);
    });

    it("rejects a non-existent user", async () => {
      const org = await newOrg();

      await expect(newLog(org.tenantId, { userId: randomUUID() })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: org.tenantId, userId: randomUUID() })).rejects.toThrow(USER_FK);
    });

    it("rejects a user of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(newLog(a.tenantId, { userId: b.user.id })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: a.tenantId, userId: b.user.id })).rejects.toThrow(USER_FK);
    });
  });

  describe("optional branch", () => {
    it("accepts an event without branch", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { userId: org.user.id, branchId: null });

      expect(log.branchId).toBeNull();
      await rawInsert({ tenantId: org.tenantId, branchId: null });
    });

    it("accepts a branch of the same tenant", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { branchId: org.branch.id });

      expect(log.branchId).toBe(org.branch.id);
    });

    it("rejects a non-existent branch", async () => {
      const org = await newOrg();

      await expect(newLog(org.tenantId, { branchId: randomUUID() })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: org.tenantId, branchId: randomUUID() })).rejects.toThrow(BRANCH_FK);
    });

    it("rejects a branch of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(newLog(a.tenantId, { branchId: b.branch.id })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: a.tenantId, branchId: b.branch.id })).rejects.toThrow(BRANCH_FK);
    });
  });

  describe("optional device", () => {
    it("accepts an event without device", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { userId: org.user.id, deviceId: null });

      expect(log.deviceId).toBeNull();
      await rawInsert({ tenantId: org.tenantId, deviceId: null });
    });

    it("accepts a device of the same tenant, including a device-only event", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { deviceId: org.device.id, action: "device.revoked", resourceType: "device", resourceId: org.device.id });

      expect(log).toMatchObject({ userId: null, deviceId: org.device.id, resourceId: org.device.id });
    });

    it("rejects a non-existent device", async () => {
      const org = await newOrg();

      await expect(newLog(org.tenantId, { deviceId: randomUUID() })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: org.tenantId, deviceId: randomUUID() })).rejects.toThrow(DEVICE_FK);
    });

    it("rejects a device of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(newLog(a.tenantId, { deviceId: b.device.id })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: a.tenantId, deviceId: b.device.id })).rejects.toThrow(DEVICE_FK);
    });
  });

  describe("action", () => {
    it.each(["user.created", "order.item.cancelled", "fiscal_document.cancelled", "cash2.closed", "a.b"])(
      "accepts the technical format %s",
      async (action) => {
        const org = await newOrg();
        const log = await newLog(org.tenantId, { action });

        expect(log.action).toBe(action);
      },
    );

    it.each([
      ["uppercase", "User.Created"],
      ["a space", "user created"],
      ["a leading dot", ".created"],
      ["a trailing dot", "created."],
      ["a single segment", "created"],
      ["an empty segment", "user..created"],
      ["a hyphen", "user.created-now"],
      ["a segment starting with a digit", "user.2fa_enabled"],
      ["a segment starting with underscore", "_user.created"],
      ["surrounding spaces", " user.created "],
      ["a trailing newline", "user.created\n"],
      ["empty text", ""],
    ])("rejects an action with %s (Prisma and SQL)", async (_, action) => {
      const org = await newOrg();

      await expect(newLog(org.tenantId, { action })).rejects.toThrow(ACTION_CHECK);
      await expect(rawInsert({ tenantId: org.tenantId, action })).rejects.toThrow(ACTION_CHECK);
    });
  });

  describe("resource_type", () => {
    it.each(["user", "fiscal_document", "order2"])("accepts the technical format %s", async (resourceType) => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { resourceType });

      expect(log.resourceType).toBe(resourceType);
    });

    it.each([
      ["uppercase", "User"],
      ["a dot", "order.item"],
      ["a hyphen", "fiscal-document"],
      ["a space", "fiscal document"],
      ["a leading digit", "2fa"],
      ["a leading underscore", "_user"],
      ["empty text", ""],
    ])("rejects a resource_type with %s (Prisma and SQL)", async (_, resourceType) => {
      const org = await newOrg();

      await expect(newLog(org.tenantId, { resourceType })).rejects.toThrow(RESOURCE_TYPE_CHECK);
      await expect(rawInsert({ tenantId: org.tenantId, resourceType })).rejects.toThrow(RESOURCE_TYPE_CHECK);
    });
  });

  describe("resource_id (logical reference, no FK)", () => {
    it("accepts a uuid that references nothing, and keeps the log after the resource is gone", async () => {
      const org = await newOrg();
      const orphan = await newLog(org.tenantId, { action: "order.cancelled", resourceType: "order", resourceId: randomUUID() });

      const other = await newOrg("Other");
      const role = await prisma.role.create({ data: { tenantId: other.tenantId, code: "TEMP", name: "Temp", status: "ACTIVE" } });
      const log = await newLog(other.tenantId, { action: "role.deleted", resourceType: "role", resourceId: role.id });
      await prisma.role.delete({ where: { id: role.id } });

      expect(await prisma.auditLog.findUnique({ where: { id: orphan.id } })).not.toBeNull();
      expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })).resourceId).toBe(role.id);
    });

    it("is stored as uuid and rejects non-uuid text", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { resourceId: org.user.id });

      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(resource_id)::text AS type FROM audit_logs WHERE id = ${log.id}::uuid`;
      expect(row?.type).toBe("uuid");
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO audit_logs (id, tenant_id, action, resource_type, resource_id)
           VALUES (gen_random_uuid(), $1::uuid, 'user.created', 'user', 'ORDER-123')`,
          org.tenantId,
        ),
      ).rejects.toThrow(/invalid input syntax for type uuid/);
    });

    it("has no FK on resource_id", async () => {
      const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
        WHERE con.conrelid = 'public.audit_logs'::regclass AND con.contype = 'f' AND a.attname = 'resource_id'`;
      expect(row?.count).toBe(0n);
    });
  });

  describe("metadata", () => {
    it("accepts NULL (SQL NULL, not a JSON null)", async () => {
      const org = await newOrg();
      const omitted = await newLog(org.tenantId);
      const explicit = await newLog(org.tenantId, { metadata: Prisma.DbNull });

      const rows = await prisma.$queryRaw<{ isNull: boolean }[]>`
        SELECT metadata IS NULL AS "isNull" FROM audit_logs WHERE id IN (${omitted.id}::uuid, ${explicit.id}::uuid)`;
      expect(rows).toEqual([{ isNull: true }, { isNull: true }]);
    });

    it("stores structured context as jsonb and reads it back", async () => {
      const org = await newOrg();
      const metadata = {
        reason: "troca de turno",
        source: "admin",
        before: { status: "ACTIVE" },
        after: { status: "DISABLED" },
        items: [1, "dois", null, true],
      };
      const log = await newLog(org.tenantId, { action: "user.disabled", resourceId: org.user.id, metadata });

      const [row] = await prisma.$queryRaw<{ type: string; status: string }[]>`
        SELECT pg_typeof(metadata)::text AS type, metadata #>> '{after,status}' AS status
        FROM audit_logs WHERE id = ${log.id}::uuid`;
      expect(row).toEqual({ type: "jsonb", status: "DISABLED" });
      expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })).metadata).toEqual(metadata);
    });

    it("rejects invalid JSON", async () => {
      const org = await newOrg();

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO audit_logs (id, tenant_id, action, resource_type, metadata)
           VALUES (gen_random_uuid(), $1::uuid, 'user.created', 'user', '{not json'::jsonb)`,
          org.tenantId,
        ),
      ).rejects.toThrow(/invalid input syntax for type json/);
    });
  });

  describe("ip_address", () => {
    it("accepts NULL", async () => {
      const org = await newOrg();

      expect((await newLog(org.tenantId, { ipAddress: null })).ipAddress).toBeNull();
    });

    it.each(["203.0.113.10", "2001:db8::1", "::ffff:192.0.2.1"])("stores %s as inet", async (ipAddress) => {
      const org = await newOrg();
      const log = await newLog(org.tenantId, { ipAddress });

      const [row] = await prisma.$queryRaw<{ ip: string; type: string }[]>`
        SELECT host(ip_address) AS ip, pg_typeof(ip_address)::text AS type FROM audit_logs WHERE id = ${log.id}::uuid`;
      expect(row).toEqual({ ip: ipAddress, type: "inet" });
      expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })).ipAddress).toBe(ipAddress);
    });

    it("rejects an invalid ip_address", async () => {
      const org = await newOrg();

      for (const ipAddress of ["not-an-ip", "999.1.1.1", ""]) {
        await expect(newLog(org.tenantId, { ipAddress })).rejects.toThrow(/invalid input syntax for type inet/);
      }
    });
  });

  describe("structure (append-only)", () => {
    it("has exactly the approved columns: no updated_at, deleted_at, status or credential column", async () => {
      const columns = await prisma.$queryRaw<{ name: string }[]>`
        SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' ORDER BY ordinal_position`;
      const names = columns.map((c) => c.name);

      expect(names).toEqual([
        "id",
        "tenant_id",
        "user_id",
        "branch_id",
        "device_id",
        "action",
        "resource_type",
        "resource_id",
        "metadata",
        "ip_address",
        "created_at",
      ]);
      const credentialLike = /(token|password|passwd|senha|secret|api_?key|private_?key|pin|hash)/i;
      expect(names.filter((n) => credentialLike.test(n))).toEqual([]);
    });

    it("uses plain text (no enum) for action and resource_type", async () => {
      const [enums] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_type WHERE typtype = 'e' AND typname LIKE 'audit%'`;
      const rows = await prisma.$queryRaw<{ name: string; type: string }[]>`
        SELECT column_name AS name, data_type AS type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name IN ('action', 'resource_type')
        ORDER BY column_name`;
      expect(enums?.count).toBe(0n);
      expect(rows).toEqual([
        { name: "action", type: "text" },
        { name: "resource_type", type: "text" },
      ]);
    });

  });

  describe("append-only (trigger audit_logs_append_only)", () => {
    /** Full row as stored, to prove a rejected mutation left it untouched. */
    async function snapshot(id: string) {
      const [row] = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT to_jsonb(l) AS row FROM audit_logs l WHERE id = ${id}::uuid`;
      return row?.row;
    }

    async function linkedLog() {
      const org = await newOrg();
      const log = await newLog(org.tenantId, {
        userId: org.user.id,
        branchId: org.branch.id,
        deviceId: org.device.id,
        action: "user.disabled",
        resourceType: "user",
        resourceId: org.user.id,
        metadata: { reason: "desligamento" },
        ipAddress: "203.0.113.10",
      });
      return { org, log, before: await snapshot(log.id) };
    }

    it("keeps INSERT working (Prisma and SQL)", async () => {
      const org = await newOrg();
      await newLog(org.tenantId);
      await rawInsert({ tenantId: org.tenantId, userId: org.user.id });

      expect(await prisma.auditLog.count({ where: { tenantId: org.tenantId } })).toBe(2);
    });

    it("rejects UPDATE via Prisma and leaves the row intact", async () => {
      const { log, before } = await linkedLog();

      await expect(prisma.auditLog.update({ where: { id: log.id }, data: { action: "user.enabled" } })).rejects.toThrow(
        APPEND_ONLY,
      );
      await expect(prisma.auditLog.updateMany({ where: { id: log.id }, data: { metadata: Prisma.DbNull } })).rejects.toThrow(
        APPEND_ONLY,
      );
      expect(await snapshot(log.id)).toEqual(before);
    });

    it("rejects UPDATE via SQL, including a no-op and a bulk update, and leaves the row intact", async () => {
      const { org, log, before } = await linkedLog();

      await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'user.enabled' WHERE id = ${log.id}::uuid`).rejects.toThrow(
        APPEND_ONLY_UPDATE,
      );
      await expect(prisma.$executeRaw`UPDATE audit_logs SET action = action WHERE id = ${log.id}::uuid`).rejects.toThrow(
        APPEND_ONLY_UPDATE,
      );
      await expect(
        prisma.$executeRaw`UPDATE audit_logs SET metadata = NULL WHERE tenant_id = ${org.tenantId}::uuid`,
      ).rejects.toThrow(APPEND_ONLY_UPDATE);
      expect(await snapshot(log.id)).toEqual(before);
    });

    it("rejects DELETE via Prisma and leaves the row intact", async () => {
      const { log, before } = await linkedLog();

      await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(APPEND_ONLY);
      await expect(prisma.auditLog.deleteMany({ where: { id: log.id } })).rejects.toThrow(APPEND_ONLY);
      expect(await snapshot(log.id)).toEqual(before);
    });

    it("rejects DELETE via SQL, including a bulk delete, and leaves the row intact", async () => {
      const { org, log, before } = await linkedLog();

      await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${log.id}::uuid`).rejects.toThrow(APPEND_ONLY_DELETE);
      await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${org.tenantId}::uuid`).rejects.toThrow(
        APPEND_ONLY_DELETE,
      );
      expect(await snapshot(log.id)).toEqual(before);
    });

    it("keeps accepting INSERTs after rejected mutations", async () => {
      const { org, log } = await linkedLog();
      await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'x.y' WHERE id = ${log.id}::uuid`).rejects.toThrow(
        APPEND_ONLY_UPDATE,
      );
      await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${log.id}::uuid`).rejects.toThrow(APPEND_ONLY_DELETE);

      const next = await newLog(org.tenantId, { action: "user.enabled", resourceId: org.user.id });
      await rawInsert({ tenantId: org.tenantId });

      expect(next.action).toBe("user.enabled");
      expect(await prisma.auditLog.count({ where: { tenantId: org.tenantId } })).toBe(3);
    });

    it("defines forbid_audit_log_mutation() as a trigger function in public", async () => {
      const rows = await prisma.$queryRaw<{ name: string; returns: string; language: string; args: string }[]>`
        SELECT p.proname::text AS name, format_type(p.prorettype, NULL) AS returns, l.lanname::text AS language,
               pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.proname = 'forbid_audit_log_mutation'`;
      expect(rows).toEqual([{ name: "forbid_audit_log_mutation", returns: "trigger", language: "plpgsql", args: "" }]);
    });

    it("attaches an enabled BEFORE UPDATE OR DELETE row trigger to audit_logs (and only there)", async () => {
      const rows = await prisma.$queryRaw<
        { name: string; table: string; enabled: string; row: boolean; before: boolean; onInsert: boolean; onUpdate: boolean; onDelete: boolean; onTruncate: boolean; definition: string }[]
      >`
        SELECT t.tgname::text AS name, c.relname::text AS "table", t.tgenabled::text AS enabled,
               (t.tgtype & 1) <> 0 AS row, (t.tgtype & 2) <> 0 AS before, (t.tgtype & 4) <> 0 AS "onInsert",
               (t.tgtype & 16) <> 0 AS "onUpdate", (t.tgtype & 8) <> 0 AS "onDelete", (t.tgtype & 32) <> 0 AS "onTruncate",
               pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgfoid = 'public.forbid_audit_log_mutation()'::regprocedure`;
      expect(rows).toEqual([
        {
          name: "audit_logs_append_only",
          table: "audit_logs",
          // 'O' = enabled in origin and local replication modes (default).
          enabled: "O",
          row: true,
          before: true,
          onInsert: false,
          onUpdate: true,
          onDelete: true,
          onTruncate: false,
          definition:
            "CREATE TRIGGER audit_logs_append_only BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation()",
        },
      ]);
    });
  });

  describe("multi-tenant isolation on update", () => {
    /**
     * Runs one UPDATE with the append-only trigger disabled, inside a transaction that is always rolled back,
     * and returns its error message (null if accepted). Proves the composite FKs still guard on their own.
     */
    function updateWithoutAppendOnly(update: Prisma.Sql): Promise<string | null> {
      return inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`);
        try {
          await tx.$queryRaw(update);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
    }

    it("rejects changing user_id, branch_id or device_id, including from NULL (append-only, Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const linked = await newLog(a.tenantId, { userId: a.user.id, branchId: a.branch.id, deviceId: a.device.id });
      const bare = await newLog(a.tenantId);

      for (const { id } of [linked, bare]) {
        await expect(prisma.auditLog.update({ where: { id }, data: { userId: b.user.id } })).rejects.toThrow(APPEND_ONLY);
        await expect(prisma.auditLog.update({ where: { id }, data: { branchId: b.branch.id } })).rejects.toThrow(APPEND_ONLY);
        await expect(prisma.auditLog.update({ where: { id }, data: { deviceId: b.device.id } })).rejects.toThrow(APPEND_ONLY);
        await expect(prisma.$executeRaw`UPDATE audit_logs SET user_id = ${b.user.id}::uuid WHERE id = ${id}::uuid`).rejects.toThrow(
          APPEND_ONLY_UPDATE,
        );
      }
    });

    it("still rejects cross-tenant user, branch or device through the composite FKs when the trigger is disabled", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const linked = await newLog(a.tenantId, { userId: a.user.id, branchId: a.branch.id, deviceId: a.device.id });
      const bare = await newLog(a.tenantId);

      for (const { id } of [linked, bare]) {
        expect(await updateWithoutAppendOnly(Prisma.sql`UPDATE audit_logs SET user_id = ${b.user.id}::uuid WHERE id = ${id}::uuid`)).toMatch(
          USER_FK,
        );
        expect(
          await updateWithoutAppendOnly(Prisma.sql`UPDATE audit_logs SET branch_id = ${b.branch.id}::uuid WHERE id = ${id}::uuid`),
        ).toMatch(BRANCH_FK);
        expect(
          await updateWithoutAppendOnly(Prisma.sql`UPDATE audit_logs SET device_id = ${b.device.id}::uuid WHERE id = ${id}::uuid`),
        ).toMatch(DEVICE_FK);
      }
      expect(
        await updateWithoutAppendOnly(Prisma.sql`UPDATE audit_logs SET tenant_id = ${b.tenantId}::uuid WHERE id = ${linked.id}::uuid`),
      ).toMatch(/audit_logs_tenant_id_(user|branch|device)_id_fkey/);
      // The rollback restored the trigger.
      await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${bare.id}::uuid`).rejects.toThrow(APPEND_ONLY_DELETE);
    });

    it("rejects changing tenant_id, with or without user, branch or device (append-only, Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const linked = await newLog(a.tenantId, { userId: a.user.id, branchId: a.branch.id, deviceId: a.device.id });
      const bare = await newLog(a.tenantId);

      for (const log of [linked, bare]) {
        await expect(prisma.auditLog.update({ where: { id: log.id }, data: { tenantId: b.tenantId } })).rejects.toThrow(APPEND_ONLY);
        await expect(
          prisma.$executeRaw`UPDATE audit_logs SET tenant_id = ${b.tenantId}::uuid WHERE id = ${log.id}::uuid`,
        ).rejects.toThrow(APPEND_ONLY_UPDATE);
        expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })).tenantId).toBe(a.tenantId);
      }
    });

    it("blocks moving a user, branch or device referenced by an audit log to another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const tenantLevelDevice = await prisma.device.create({
        data: { tenantId: a.tenantId, name: "adm", deviceType: DeviceType.ADMIN, deviceKey: "adm-001", status: DeviceStatus.ACTIVE },
      });
      await newLog(a.tenantId, { userId: a.user.id, branchId: a.branch.id, deviceId: tenantLevelDevice.id });

      await expect(
        prisma.$executeRaw`UPDATE users SET tenant_id = ${b.tenantId}::uuid, employee_number = 'X-1' WHERE id = ${a.user.id}::uuid`,
      ).rejects.toThrow(USER_FK);
      await expect(
        prisma.$executeRaw`UPDATE devices SET tenant_id = ${b.tenantId}::uuid, device_key = 'X-1' WHERE id = ${tenantLevelDevice.id}::uuid`,
      ).rejects.toThrow(DEVICE_FK);
      await expect(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${b.tenantId}::uuid, code = 'X-1' WHERE id = ${a.branch.id}::uuid`,
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it("has no audit log in the database whose user, branch or device belongs to another tenant", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM audit_logs l
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN branches br ON br.id = l.branch_id
        LEFT JOIN devices d ON d.id = l.device_id
        WHERE (u.id IS NOT NULL AND u.tenant_id <> l.tenant_id)
           OR (br.id IS NOT NULL AND br.tenant_id <> l.tenant_id)
           OR (d.id IS NOT NULL AND d.tenant_id <> l.tenant_id)`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a user, branch or device referenced by an audit log", async () => {
      const org = await newOrg();
      await newLog(org.tenantId, { userId: org.user.id, branchId: org.branch.id });
      const deviceOrg = await newOrg();
      await newLog(deviceOrg.tenantId, { deviceId: deviceOrg.device.id });

      await expect(prisma.$executeRaw`DELETE FROM users WHERE id = ${org.user.id}::uuid`).rejects.toThrow(USER_FK);
      await expect(prisma.$executeRaw`DELETE FROM devices WHERE id = ${deviceOrg.device.id}::uuid`).rejects.toThrow(DEVICE_FK);
      // Only the audit log points at the branch: its device has no log in this org.
      await prisma.device.delete({ where: { id: org.device.id } });
      await expect(prisma.$executeRaw`DELETE FROM branches WHERE id = ${org.branch.id}::uuid`).rejects.toThrow(BRANCH_FK);
    });

    it("refuses to delete a tenant that has an audit log", async () => {
      const org = await newOrg();
      const log = await newLog(org.tenantId);

      await expect(prisma.tenant.delete({ where: { id: org.tenantId } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${org.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.auditLog.findUnique({ where: { id: log.id } })).not.toBeNull();
    });
  });
});
