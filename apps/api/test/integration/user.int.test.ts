import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

// Opaque test value shaped like a future Argon2id hash; no hashing is implemented in M1.5.
const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQxMjM0NTY$7mZ0Yp0bJ9l5O0f3xq1kq7c6p1yQe4m3c2b1a0Z9Y8X";

describe("User (PostgreSQL)", () => {
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

  type UserInput = Partial<{
    name: string;
    employeeNumber: string;
    passwordHash: string;
    status: UserStatus;
    mustChangePassword: boolean;
    failedLoginAttempts: number;
  }>;

  function newUser(tenantId: string, overrides: UserInput = {}) {
    return prisma.user.create({
      data: { tenantId, name: "Maria Souza", employeeNumber: "1001", passwordHash: HASH, status: UserStatus.ACTIVE, ...overrides },
    });
  }

  /** Raw insert bypassing Prisma validation, relying on database defaults for the remaining columns. */
  function rawInsert(values: {
    tenantId: string;
    name?: string;
    employeeNumber?: string;
    passwordHash?: string | null;
    status?: string;
  }) {
    const { tenantId, name = "Maria Souza", employeeNumber = "1001", passwordHash = HASH, status = "ACTIVE" } = values;
    return prisma.$executeRaw`
      INSERT INTO users (id, tenant_id, name, employee_number, password_hash, status, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${name}, ${employeeNumber}, ${passwordHash},
              ${status}::user_status, now())`;
  }

  describe("creation and tenant", () => {
    it("creates a valid user", async () => {
      const tenant = await newTenant();
      const user = await newUser(tenant.id);

      expect(await prisma.user.findUnique({ where: { id: user.id } })).toEqual(user);
    });

    it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
      const tenant = await newTenant();
      const before = Date.now();
      const user = await newUser(tenant.id);
      const after = Date.now();

      expect(user.id).toMatch(UUID_V7);
      expect(uuidV7Millis(user.id)).toBeGreaterThanOrEqual(before);
      expect(uuidV7Millis(user.id)).toBeLessThanOrEqual(after);
      const [row] = await prisma.$queryRaw<{ type: string }[]>`
        SELECT pg_typeof(id)::text AS type FROM users WHERE id = ${user.id}::uuid`;
      expect(row?.type).toBe("uuid");
    });

    it("links the user to its tenant (Tenant 1 -> N User)", async () => {
      const tenant = await newTenant();
      const a = await newUser(tenant.id, { employeeNumber: "1001" });
      const b = await newUser(tenant.id, { employeeNumber: "1002" });

      const withUsers = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        include: { users: { orderBy: { employeeNumber: "asc" } } },
      });
      expect(withUsers.users.map((u) => u.id)).toEqual([a.id, b.id]);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id }, include: { tenant: true } })).tenant.id).toBe(
        tenant.id,
      );
    });

    it("rejects a non-existent tenant", async () => {
      await expect(newUser(randomUUID())).rejects.toMatchObject({ code: "P2003" });
      await expect(rawInsert({ tenantId: randomUUID() })).rejects.toThrow(/users_tenant_id_fkey/);
    });
  });

  describe("name", () => {
    it("persists the name exactly", async () => {
      const user = await newUser((await newTenant()).id, { name: "José D'Ávila Conceição" });

      const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT name FROM users WHERE id = ${user.id}::uuid`;
      expect(row?.name).toBe("José D'Ávila Conceição");
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects a name that is %s", async (_, name) => {
      const tenant = await newTenant();

      await expect(rawInsert({ tenantId: tenant.id, name })).rejects.toThrow(/users_name_check/);
      await expect(newUser(tenant.id, { name })).rejects.toThrow(/users_name_check/);
    });
  });

  describe("employee_number", () => {
    it("persists the employee number exactly, without imposing a numeric format", async () => {
      const tenant = await newTenant();
      const user = await newUser(tenant.id, { employeeNumber: "MOR-0042a" });

      const [row] = await prisma.$queryRaw<{ employeeNumber: string }[]>`
        SELECT employee_number AS "employeeNumber" FROM users WHERE id = ${user.id}::uuid`;
      expect(row?.employeeNumber).toBe("MOR-0042a");
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects an employee number that is %s", async (_, employeeNumber) => {
      const tenant = await newTenant();

      await expect(rawInsert({ tenantId: tenant.id, employeeNumber })).rejects.toThrow(/users_employee_number_check/);
      await expect(newUser(tenant.id, { employeeNumber })).rejects.toThrow(/users_employee_number_check/);
    });

    it("rejects a duplicate employee number in the same tenant", async () => {
      const tenant = await newTenant();
      await newUser(tenant.id, { employeeNumber: "1001" });

      await expect(newUser(tenant.id, { employeeNumber: "1001", name: "Outra Pessoa" })).rejects.toMatchObject({
        code: "P2002",
      });
      await expect(rawInsert({ tenantId: tenant.id, employeeNumber: "1001" })).rejects.toThrow(
        /users_tenant_id_employee_number_key/,
      );
    });

    it("accepts the same employee number in different tenants", async () => {
      const a = await newUser((await newTenant("A")).id, { employeeNumber: "1001" });
      const b = await newUser((await newTenant("B")).id, { employeeNumber: "1001" });

      expect(a.employeeNumber).toBe(b.employeeNumber);
      expect(a.tenantId).not.toBe(b.tenantId);
    });
  });

  describe("password_hash", () => {
    it("is required", async () => {
      const tenant = await newTenant();

      await expect(rawInsert({ tenantId: tenant.id, passwordHash: null })).rejects.toThrow(
        /null value in column "password_hash"/,
      );
      await expect(
        prisma.user.create({
          // @ts-expect-error passwordHash is required by the generated types
          data: { tenantId: tenant.id, name: "Sem Hash", employeeNumber: "1001", status: UserStatus.ACTIVE },
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects a hash that is %s", async (_, passwordHash) => {
      const tenant = await newTenant();

      await expect(rawInsert({ tenantId: tenant.id, passwordHash })).rejects.toThrow(/users_password_hash_check/);
    });

    it("persists the hash without any transformation", async () => {
      const user = await newUser((await newTenant()).id);

      const [row] = await prisma.$queryRaw<{ passwordHash: string; length: number }[]>`
        SELECT password_hash AS "passwordHash", length(password_hash)::int AS length
        FROM users WHERE id = ${user.id}::uuid`;
      expect(row).toEqual({ passwordHash: HASH, length: HASH.length });
      expect(user.passwordHash).toBe(HASH);
    });
  });

  describe("status", () => {
    it.each(Object.values(UserStatus))("persists status %s", async (status) => {
      const user = await newUser((await newTenant()).id, { status });

      const [row] = await prisma.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM users WHERE id = ${user.id}::uuid`;
      expect(row?.status).toBe(status);
    });

    it("only knows ACTIVE, DISABLED and LOCKED", () => {
      expect(Object.values(UserStatus)).toEqual(["ACTIVE", "DISABLED", "LOCKED"]);
    });

    it("rejects an invalid status", async () => {
      const tenant = await newTenant();

      for (const invalid of ["INACTIVE", "DELETED", "active", ""]) {
        await expect(rawInsert({ tenantId: tenant.id, status: invalid })).rejects.toThrow(
          /invalid input value for enum user_status/,
        );
      }
      await expect(newUser(tenant.id, { status: "DELETED" as UserStatus })).rejects.toThrow();
      expect(await prisma.user.count({ where: { tenantId: tenant.id } })).toBe(0);
    });
  });

  describe("security fields", () => {
    it("defaults must_change_password to false and failed_login_attempts to 0 (Prisma and database)", async () => {
      const tenant = await newTenant();
      const user = await newUser(tenant.id, { employeeNumber: "1001" });
      await rawInsert({ tenantId: tenant.id, employeeNumber: "1002" });

      expect(user).toMatchObject({ mustChangePassword: false, failedLoginAttempts: 0 });
      const [row] = await prisma.$queryRaw<{ mustChangePassword: boolean; failedLoginAttempts: number }[]>`
        SELECT must_change_password AS "mustChangePassword", failed_login_attempts AS "failedLoginAttempts"
        FROM users WHERE tenant_id = ${tenant.id}::uuid AND employee_number = '1002'`;
      expect(row).toEqual({ mustChangePassword: false, failedLoginAttempts: 0 });
    });

    it("accepts must_change_password = true", async () => {
      const user = await newUser((await newTenant()).id, { mustChangePassword: true });

      const [row] = await prisma.$queryRaw<{ value: boolean }[]>`
        SELECT must_change_password AS value FROM users WHERE id = ${user.id}::uuid`;
      expect(row?.value).toBe(true);
    });

    it("rejects a negative failed_login_attempts", async () => {
      const user = await newUser((await newTenant()).id);

      await expect(
        prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: -1 } }),
      ).rejects.toThrow(/users_failed_login_attempts_check/);
      await expect(
        prisma.$executeRaw`UPDATE users SET failed_login_attempts = -1 WHERE id = ${user.id}::uuid`,
      ).rejects.toThrow(/users_failed_login_attempts_check/);
      expect((await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 3 } })).failedLoginAttempts).toBe(3);
    });

    it("accepts null locked_until, last_login_at and disabled_at", async () => {
      const user = await newUser((await newTenant()).id);

      expect(user).toMatchObject({ lockedUntil: null, lastLoginAt: null, disabledAt: null });
      const [row] = await prisma.$queryRaw<{ locked: boolean; lastLogin: boolean; disabled: boolean }[]>`
        SELECT locked_until IS NULL AS locked, last_login_at IS NULL AS "lastLogin", disabled_at IS NULL AS disabled
        FROM users WHERE id = ${user.id}::uuid`;
      expect(row).toEqual({ locked: true, lastLogin: true, disabled: true });
    });

    it("persists locked_until, last_login_at and disabled_at as UTC instants", async () => {
      const lockedUntil = new Date("2026-10-02T15:30:00.250Z");
      const lastLoginAt = new Date("2026-10-02T11:00:00.000Z");
      const disabledAt = new Date("2026-10-03T02:59:59.999Z");
      const user = await prisma.user.create({
        data: {
          tenantId: (await newTenant()).id,
          name: "Datas",
          employeeNumber: "1001",
          passwordHash: HASH,
          status: UserStatus.DISABLED,
          lockedUntil,
          lastLoginAt,
          disabledAt,
        },
      });

      const [row] = await prisma.$queryRaw<{ lockedUntil: string; lastLoginAt: string; disabledAt: string }[]>`
        SELECT to_char(locked_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lockedUntil",
               to_char(last_login_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastLoginAt",
               to_char(disabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "disabledAt"
        FROM users WHERE id = ${user.id}::uuid`;
      expect(row).toEqual({
        lockedUntil: lockedUntil.toISOString(),
        lastLoginAt: lastLoginAt.toISOString(),
        disabledAt: disabledAt.toISOString(),
      });
    });
  });

  describe("timestamps", () => {
    it("stores created_at/updated_at as correct UTC instants", async () => {
      const skewMs = 5_000; // tolerance between test-runner and database clocks
      const before = Date.now();
      const user = await newUser((await newTenant()).id);

      expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
      expect(user.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + skewMs);

      // Compared with the database clock: a session time-zone shift would show up as hours of drift.
      const [row] = await prisma.$queryRaw<{ createdAt: Date; driftSeconds: number; createdUtc: string }[]>`
        SELECT created_at AS "createdAt",
               abs(extract(epoch FROM now() - created_at))::float8 AS "driftSeconds",
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdUtc"
        FROM users WHERE id = ${user.id}::uuid`;
      expect(row?.createdAt).toEqual(user.createdAt);
      expect(row?.driftSeconds).toBeLessThan(skewMs / 1000);
      expect(row?.createdUtc).toBe(user.createdAt.toISOString());
    });

    it("refreshes updated_at on update and keeps created_at", async () => {
      const user = await newUser((await newTenant()).id);
      await new Promise((r) => setTimeout(r, 20));

      const updated = await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.DISABLED } });

      expect(updated.createdAt).toEqual(user.createdAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
    });
  });

  describe("physical deletion", () => {
    it("refuses to delete a tenant that has a user", async () => {
      const tenant = await newTenant();
      const user = await newUser(tenant.id);

      await expect(prisma.tenant.delete({ where: { id: tenant.id } })).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenant.id}::uuid`).rejects.toThrow(
        /users_tenant_id_fkey/,
      );
      expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    });
  });
});
