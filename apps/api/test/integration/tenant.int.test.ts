import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TenantStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { UUID_V7, uuidV7Millis } from "./uuid.js";

describe("Tenant (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a tenant", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Loja A", status: TenantStatus.TRIAL } });

    const found = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(found).toEqual(tenant);
  });

  it("generates a UUIDv7 id stored as a PostgreSQL uuid", async () => {
    const before = Date.now();
    const tenant = await prisma.tenant.create({ data: { name: "Loja UUID", status: TenantStatus.ACTIVE } });
    const after = Date.now();

    expect(tenant.id).toMatch(UUID_V7);
    expect(uuidV7Millis(tenant.id)).toBeGreaterThanOrEqual(before);
    expect(uuidV7Millis(tenant.id)).toBeLessThanOrEqual(after);

    const [row] = await prisma.$queryRaw<{ type: string }[]>`
      SELECT pg_typeof(id)::text AS type FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(row?.type).toBe("uuid");
  });

  it("generates distinct ids", async () => {
    const tenants = await Promise.all(
      Array.from({ length: 20 }, (_, i) => prisma.tenant.create({ data: { name: `Loja ${i}`, status: TenantStatus.TRIAL } })),
    );
    expect(new Set(tenants.map((t) => t.id)).size).toBe(20);
  });

  it("persists the name exactly", async () => {
    const name = "Lanchonete São João — Piso 2 (Açaí & Cia)";
    const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.TRIAL } });

    const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(row?.name).toBe(name);
  });

  it.each(Object.values(TenantStatus))("persists status %s", async (status) => {
    const tenant = await prisma.tenant.create({ data: { name: `Loja ${status}`, status } });

    const [row] = await prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(row?.status).toBe(status);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe(status);
  });

  it("only knows the five approved statuses", () => {
    expect(Object.values(TenantStatus)).toEqual(["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED"]);
  });

  it("accepts null trial_started_at", async () => {
    const tenant = await prisma.tenant.create({
      data: { name: "Sem início", status: TenantStatus.ACTIVE, trialEndsAt: new Date("2026-11-01T00:00:00.000Z") },
    });

    expect(tenant.trialStartedAt).toBeNull();
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT trial_started_at IS NULL AS "isNull" FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(row?.isNull).toBe(true);
  });

  it("accepts null trial_ends_at", async () => {
    const tenant = await prisma.tenant.create({
      data: { name: "Sem fim", status: TenantStatus.ACTIVE, trialStartedAt: new Date("2026-10-01T00:00:00.000Z") },
    });

    expect(tenant.trialEndsAt).toBeNull();
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT trial_ends_at IS NULL AS "isNull" FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(row?.isNull).toBe(true);
  });

  it("pins the session time zone to UTC even though the database default is not UTC", async () => {
    const [row] = await prisma.$queryRaw<{ session: string; databaseDefault: string }[]>`
      SELECT current_setting('TimeZone') AS session,
             (SELECT unnest(setconfig) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
              WHERE d.datname = current_database() AND s.setrole = 0) AS "databaseDefault"`;
    expect(row).toEqual({ session: "UTC", databaseDefault: "TimeZone=America/Sao_Paulo" });
  });

  it("persists trial dates as UTC instants regardless of session time zone", async () => {
    const trialStartedAt = new Date("2026-10-02T12:34:56.789Z");
    const trialEndsAt = new Date("2026-11-01T02:59:59.999Z");
    const tenant = await prisma.tenant.create({
      data: { name: "Datas", status: TenantStatus.TRIAL, trialStartedAt, trialEndsAt },
    });

    const [utc] = await prisma.$queryRaw<{ started: string; ends: string }[]>`
      SELECT to_char(trial_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS started,
             to_char(trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS ends
      FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(utc).toEqual({ started: "2026-10-02T12:34:56.789", ends: "2026-11-01T02:59:59.999" });

    // Same instant when the session uses a non-UTC zone.
    const [local] = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Sao_Paulo'");
      return tx.$queryRaw<{ started: string; equal: boolean }[]>`
        SELECT trial_started_at::text AS started,
               trial_started_at = ${trialStartedAt.toISOString()}::timestamptz AS equal
        FROM tenants WHERE id = ${tenant.id}::uuid`;
    });
    expect(local).toEqual({ started: "2026-10-02 09:34:56.789-03", equal: true });

    const found = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(found.trialStartedAt?.toISOString()).toBe(trialStartedAt.toISOString());
    expect(found.trialEndsAt?.toISOString()).toBe(trialEndsAt.toISOString());
  });

  it("sets created_at and updated_at, and refreshes updated_at on update", async () => {
    const skewMs = 5_000; // tolerance between test-runner and database clocks
    const before = Date.now();
    const tenant = await prisma.tenant.create({ data: { name: "Timestamps", status: TenantStatus.TRIAL } });

    expect(tenant.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
    expect(tenant.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + skewMs);
    expect(tenant.updatedAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);

    await new Promise((r) => setTimeout(r, 20));
    const updated = await prisma.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });

    expect(updated.createdAt).toEqual(tenant.createdAt);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(tenant.updatedAt.getTime());

    const [row] = await prisma.$queryRaw<{ createdAt: Date; updatedAt: Date }[]>`
      SELECT created_at AS "createdAt", updated_at AS "updatedAt" FROM tenants WHERE id = ${tenant.id}::uuid`;
    expect(row).toEqual({ createdAt: updated.createdAt, updatedAt: updated.updatedAt });
  });

  it("rejects an invalid status at the database level", async () => {
    // Unique marker: other test files insert tenants concurrently in the same database.
    const name = `Inválido ${randomUUID()}`;

    for (const invalid of ["INVALID", "trial", "DELETED", ""]) {
      await expect(
        prisma.$executeRaw`
          INSERT INTO tenants (id, name, status, updated_at)
          VALUES (gen_random_uuid(), ${name}, ${invalid}::tenant_status, now())`,
      ).rejects.toThrow(/invalid input value for enum tenant_status/);
    }

    expect(await prisma.tenant.count({ where: { name } })).toBe(0);
  });

  it("rejects an invalid status through the Prisma Client", async () => {
    await expect(
      prisma.tenant.create({ data: { name: "Inválido", status: "INVALID" as TenantStatus } }),
    ).rejects.toThrow();
  });
});
