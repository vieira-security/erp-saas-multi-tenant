import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  DeviceStatus,
  DeviceType,
  TenantStatus,
  UserStatus,
  type Device,
  type PrismaClient,
  type User,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

const USER_FK = /sessions_tenant_id_user_id_fkey/;
const DEVICE_FK = /sessions_tenant_id_device_id_fkey/;
const HOUR = 60 * 60 * 1000;

/** Opaque stand-in for a future refresh-token hash (unique: the column is globally unique). */
function tokenHash(): string {
  return `h1$${randomBytes(32).toString("base64url")}`;
}

function inOneHour(): Date {
  return new Date(Date.now() + HOUR);
}

interface Org {
  tenantId: string;
  user: User;
  device: Device;
}

describe("Session (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Tenant with one user and one branch device. */
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
    return {
      tenantId: tenant.id,
      user: await addUser(tenant.id, "1001"),
      device: await addDevice(tenant.id, branch.id, "pos-001"),
    };
  }

  function addUser(tenantId: string, employeeNumber: string) {
    return prisma.user.create({
      data: { tenantId, name: `Usuário ${employeeNumber}`, employeeNumber, passwordHash: "hash", status: UserStatus.ACTIVE },
    });
  }

  function addDevice(tenantId: string, branchId: string | null, deviceKey: string) {
    return prisma.device.create({
      data: { tenantId, branchId, name: deviceKey, deviceType: DeviceType.POS, deviceKey, status: DeviceStatus.ACTIVE },
    });
  }

  type SessionInput = Partial<{
    deviceId: string | null;
    refreshTokenHash: string;
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }>;

  function newSession(tenantId: string, userId: string, overrides: SessionInput = {}) {
    return prisma.session.create({
      data: { tenantId, userId, refreshTokenHash: tokenHash(), expiresAt: inOneHour(), ...overrides },
    });
  }

  function rawInsert(values: {
    tenantId: string;
    userId: string;
    deviceId?: string | null;
    refreshTokenHash?: string | null;
    expiresAt?: string | null;
  }) {
    const { tenantId, userId, deviceId = null, refreshTokenHash = tokenHash(), expiresAt = "now() + interval '1 hour'" } = values;
    return prisma.$executeRawUnsafe(
      `INSERT INTO sessions (id, tenant_id, user_id, device_id, refresh_token_hash, expires_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, ${expiresAt === null ? "NULL" : expiresAt})`,
      tenantId,
      userId,
      deviceId,
      refreshTokenHash,
    );
  }

  describe("basics", () => {
    it("creates a valid session linked to its tenant and user", async () => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id);

      const loaded = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
        include: { tenant: true, user: true, device: true },
      });
      expect([loaded.tenant.id, loaded.user.id]).toEqual([org.tenantId, org.user.id]);
      expect(loaded.user.tenantId).toBe(loaded.tenantId);
      expect(loaded.device).toBeNull();
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const org = await newOrg();
      const before = Date.now();
      const session = await newSession(org.tenantId, org.user.id);
      const after = Date.now();

      expect(session.id).toMatch(UUID_V7);
      expect(uuidV7Millis(session.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(session.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("rejects a non-existent tenant", async () => {
      const org = await newOrg();

      await expect(newSession(randomUUID(), org.user.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: randomUUID(), userId: org.user.id })).rejects.toThrow(
        /sessions_tenant_id(_user_id)?_fkey/,
      );
    });

    it("rejects a non-existent user", async () => {
      const org = await newOrg();

      await expect(newSession(org.tenantId, randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: org.tenantId, userId: randomUUID() })).rejects.toThrow(USER_FK);
    });

    it("rejects a user of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(newSession(a.tenantId, b.user.id)).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: a.tenantId, userId: b.user.id })).rejects.toThrow(USER_FK);
    });
  });

  describe("optional device", () => {
    it("accepts a session without device (MATCH SIMPLE skips the device FK when device_id is NULL)", async () => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id, { deviceId: null });
      await rawInsert({ tenantId: org.tenantId, userId: org.user.id, deviceId: null });

      expect(session.deviceId).toBeNull();
      expect(await prisma.session.count({ where: { userId: org.user.id, deviceId: null } })).toBe(2);
    });

    it("accepts a device of the same tenant, including a tenant-level device", async () => {
      const org = await newOrg();
      const adminDevice = await addDevice(org.tenantId, null, "admin-001");

      for (const device of [org.device, adminDevice]) {
        const session = await newSession(org.tenantId, org.user.id, { deviceId: device.id });
        const loaded = await prisma.session.findUniqueOrThrow({ where: { id: session.id }, include: { device: true } });
        expect(loaded.device?.id).toBe(device.id);
      }
    });

    it("rejects a non-existent device", async () => {
      const org = await newOrg();

      await expect(newSession(org.tenantId, org.user.id, { deviceId: randomUUID() })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: org.tenantId, userId: org.user.id, deviceId: randomUUID() })).rejects.toThrow(
        DEVICE_FK,
      );
    });

    it("rejects a device of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");

      await expect(newSession(a.tenantId, a.user.id, { deviceId: b.device.id })).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: a.tenantId, userId: a.user.id, deviceId: b.device.id })).rejects.toThrow(DEVICE_FK);
    });
  });

  describe("refresh_token_hash", () => {
    it("is required", async () => {
      const org = await newOrg();

      await expect(rawInsert({ tenantId: org.tenantId, userId: org.user.id, refreshTokenHash: null })).rejects.toThrow(
        /null value in column "refresh_token_hash"/,
      );
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects a hash that is %s", async (_, refreshTokenHash) => {
      const org = await newOrg();

      await expect(rawInsert({ tenantId: org.tenantId, userId: org.user.id, refreshTokenHash })).rejects.toThrow(
        /sessions_refresh_token_hash_check/,
      );
      await expect(newSession(org.tenantId, org.user.id, { refreshTokenHash })).rejects.toThrow(
        /sessions_refresh_token_hash_check/,
      );
    });

    it("persists the hash exactly as received", async () => {
      const org = await newOrg();
      const hash = `$argon2id$v=19$m=65536,t=3,p=4$${randomBytes(16).toString("base64")}$${randomBytes(32).toString("base64")}`;
      const session = await newSession(org.tenantId, org.user.id, { refreshTokenHash: hash });

      const [row] = await prisma.$queryRaw<{ hash: string; length: number }[]>`
        SELECT refresh_token_hash AS hash, length(refresh_token_hash)::int AS length FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row).toEqual({ hash, length: hash.length });
    });

    it("rejects a duplicate hash globally, even across tenants (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const session = await newSession(a.tenantId, a.user.id);

      await expect(newSession(a.tenantId, a.user.id, { refreshTokenHash: session.refreshTokenHash })).rejects.toMatchObject({
        code: "P2002",
      });
      await expect(
        rawInsert({ tenantId: b.tenantId, userId: b.user.id, refreshTokenHash: session.refreshTokenHash }),
      ).rejects.toThrow(/sessions_refresh_token_hash_key/);
    });

    it("stores only refresh_token_hash: no plain refresh/access token, password, secret or key column", async () => {
      const columns = await prisma.$queryRaw<{ name: string }[]>`
        SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions' ORDER BY ordinal_position`;
      const names = columns.map((c) => c.name);

      expect(names).toEqual([
        "id",
        "tenant_id",
        "user_id",
        "device_id",
        "refresh_token_hash",
        "ip_address",
        "user_agent",
        "expires_at",
        "revoked_at",
        "created_at",
      ]);
      const credentialLike = /(token|password|passwd|senha|secret|api_?key|private_?key|pin)/i;
      expect(names.filter((n) => credentialLike.test(n))).toEqual(["refresh_token_hash"]);
    });
  });

  describe("expiry and revocation", () => {
    it("requires expires_at (no default)", async () => {
      const org = await newOrg();

      await expect(rawInsert({ tenantId: org.tenantId, userId: org.user.id, expiresAt: null })).rejects.toThrow(
        /null value in column "expires_at"/,
      );
    });

    it("persists expires_at and revoked_at as UTC instants", async () => {
      const org = await newOrg();
      const expiresAt = new Date("2027-01-31T02:59:59.999Z");
      const revokedAt = new Date("2026-12-24T15:00:00.250Z");
      const session = await newSession(org.tenantId, org.user.id, { expiresAt, revokedAt });

      const [row] = await prisma.$queryRaw<{ expiresAt: string; revokedAt: string }[]>`
        SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
               to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "revokedAt"
        FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row).toEqual({ expiresAt: expiresAt.toISOString(), revokedAt: revokedAt.toISOString() });
    });

    it("creates a session without revoked_at (NULL = not revoked)", async () => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id);

      expect(session.revokedAt).toBeNull();
      const [row] = await prisma.$queryRaw<{ active: boolean }[]>`
        SELECT (revoked_at IS NULL AND expires_at > now()) AS active FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row?.active).toBe(true);
    });

    it("accepts revoked_at before or after expires_at (no coupling constraint)", async () => {
      const org = await newOrg();
      const expiresAt = inOneHour();

      await newSession(org.tenantId, org.user.id, { expiresAt, revokedAt: new Date(expiresAt.getTime() - 1000) });
      await newSession(org.tenantId, org.user.id, { expiresAt, revokedAt: new Date(expiresAt.getTime() + 1000) });
    });

    it("rejects expires_at not after created_at, and accepts explicit past sessions with an earlier created_at", async () => {
      const org = await newOrg();
      const createdAt = new Date("2026-01-01T12:00:00.000Z");

      await expect(newSession(org.tenantId, org.user.id, { expiresAt: new Date(Date.now() - HOUR) })).rejects.toThrow(
        /sessions_expires_at_check/,
      );
      await expect(newSession(org.tenantId, org.user.id, { createdAt, expiresAt: createdAt })).rejects.toThrow(
        /sessions_expires_at_check/,
      );
      const expired = await newSession(org.tenantId, org.user.id, {
        createdAt,
        expiresAt: new Date(createdAt.getTime() + HOUR),
      });
      const [row] = await prisma.$queryRaw<{ expired: boolean }[]>`
        SELECT expires_at <= now() AS expired FROM sessions WHERE id = ${expired.id}::uuid`;
      expect(row?.expired).toBe(true);
    });

    it("has no status column or enum: state derives from expires_at and revoked_at", async () => {
      const [columns] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name IN ('status', 'is_revoked', 'updated_at')`;
      const [enums] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_type WHERE typtype = 'e' AND typname LIKE 'session%'`;
      expect([columns?.count, enums?.count]).toEqual([0n, 0n]);
    });
  });

  describe("metadata", () => {
    it("accepts null ip_address and user_agent", async () => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id, { ipAddress: null, userAgent: null });

      expect(session).toMatchObject({ ipAddress: null, userAgent: null });
    });

    it.each(["203.0.113.10", "2001:db8::1", "::ffff:192.0.2.1"])("stores ip_address %s as inet", async (ipAddress) => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id, { ipAddress });

      const [row] = await prisma.$queryRaw<{ ip: string; type: string }[]>`
        SELECT host(ip_address) AS ip, pg_typeof(ip_address)::text AS type FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row).toEqual({ ip: ipAddress, type: "inet" });
      expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).ipAddress).toBe(ipAddress);
    });

    it("rejects an invalid ip_address", async () => {
      const org = await newOrg();

      for (const ipAddress of ["not-an-ip", "999.1.1.1", ""]) {
        await expect(newSession(org.tenantId, org.user.id, { ipAddress })).rejects.toThrow(/invalid input syntax for type inet/);
      }
    });

    it("stores user_agent text exactly", async () => {
      const org = await newOrg();
      const userAgent = "Mozilla/5.0 (Linux; Android 14; SM-T220) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
      const session = await newSession(org.tenantId, org.user.id, { userAgent });

      const [row] = await prisma.$queryRaw<{ userAgent: string }[]>`
        SELECT user_agent AS "userAgent" FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row?.userAgent).toBe(userAgent);
    });
  });

  describe("structure", () => {
    it("persists created_at as a correct UTC instant", async () => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id);

      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM sessions WHERE id = ${session.id}::uuid`;
      expect(row?.createdAt).toEqual(session.createdAt);
      expect(row?.driftSeconds).toBeLessThan(5);
      expect(row?.createdUtc).toBe(session.createdAt.toISOString());
    });
  });

  describe("multi-tenant isolation on update", () => {
    it("rejects changing user_id to a user of another tenant (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const session = await newSession(a.tenantId, a.user.id);

      await expect(prisma.session.update({ where: { id: session.id }, data: { userId: b.user.id } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.$executeRaw`UPDATE sessions SET user_id = ${b.user.id}::uuid WHERE id = ${session.id}::uuid`,
      ).rejects.toThrow(USER_FK);
    });

    it("rejects changing device_id to a device of another tenant, including from NULL (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const withDevice = await newSession(a.tenantId, a.user.id, { deviceId: a.device.id });
      const withoutDevice = await newSession(a.tenantId, a.user.id);

      for (const { id } of [withDevice, withoutDevice]) {
        await expect(prisma.session.update({ where: { id }, data: { deviceId: b.device.id } })).rejects.toMatchObject({
          code: "P2003",
        });
        await expect(
          prisma.$executeRaw`UPDATE sessions SET device_id = ${b.device.id}::uuid WHERE id = ${id}::uuid`,
        ).rejects.toThrow(DEVICE_FK);
      }
    });

    it("rejects changing only tenant_id (Prisma and SQL)", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const session = await newSession(a.tenantId, a.user.id, { deviceId: a.device.id });

      await expect(prisma.session.update({ where: { id: session.id }, data: { tenantId: b.tenantId } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.$executeRaw`UPDATE sessions SET tenant_id = ${b.tenantId}::uuid WHERE id = ${session.id}::uuid`,
      ).rejects.toThrow(/sessions_tenant_id_(user|device)_id_fkey/);
    });

    it("blocks moving a user or a device that has sessions to another tenant", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const tenantLevelDevice = await addDevice(a.tenantId, null, "admin-001");
      await newSession(a.tenantId, a.user.id, { deviceId: tenantLevelDevice.id });

      await expect(
        prisma.$executeRaw`UPDATE users SET tenant_id = ${b.tenantId}::uuid, employee_number = 'X-1' WHERE id = ${a.user.id}::uuid`,
      ).rejects.toThrow(USER_FK);
      await expect(
        prisma.$executeRaw`UPDATE devices SET tenant_id = ${b.tenantId}::uuid, device_key = 'X-1' WHERE id = ${tenantLevelDevice.id}::uuid`,
      ).rejects.toThrow(DEVICE_FK);
    });

    // tenant_id is conceptually immutable; the schema cannot forbid a fully consistent move.
    it("GAP (M1.14): accepts moving a whole session when tenant, user and device change together", async () => {
      const a = await newOrg("A");
      const b = await newOrg("B");
      const session = await newSession(a.tenantId, a.user.id, { deviceId: a.device.id });

      const moved = await prisma.session.update({
        where: { id: session.id },
        data: { tenantId: b.tenantId, userId: b.user.id, deviceId: b.device.id },
      });

      expect(moved).toMatchObject({ tenantId: b.tenantId, userId: b.user.id, deviceId: b.device.id });
    });

    it("has no session in the database whose user or device belongs to another tenant", async () => {
      const [row] = await prisma.$queryRaw<{ mismatches: bigint }[]>`
        SELECT count(*) AS mismatches FROM sessions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN devices d ON d.id = s.device_id
        WHERE u.tenant_id <> s.tenant_id OR (d.id IS NOT NULL AND d.tenant_id <> s.tenant_id)`;
      expect(row?.mismatches).toBe(0n);
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a user that has a session", async () => {
      const org = await newOrg();
      await newSession(org.tenantId, org.user.id);

      await expect(prisma.user.delete({ where: { id: org.user.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM users WHERE id = ${org.user.id}::uuid`).rejects.toThrow(USER_FK);
    });

    it("refuses to delete a device referenced by a session", async () => {
      const org = await newOrg();
      await newSession(org.tenantId, org.user.id, { deviceId: org.device.id });

      await expect(prisma.device.delete({ where: { id: org.device.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM devices WHERE id = ${org.device.id}::uuid`).rejects.toThrow(DEVICE_FK);
    });

    it("refuses to delete a tenant that has a session", async () => {
      const org = await newOrg();
      const session = await newSession(org.tenantId, org.user.id);

      await expect(prisma.tenant.delete({ where: { id: org.tenantId } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${org.tenantId}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    });
  });
});
