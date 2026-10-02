import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { runPrisma } from "./database.js";

// The global setup created an empty database and ran `prisma migrate deploy` on it.
describe("migrations on a clean PostgreSQL database", () => {
  const databaseUrl = inject("databaseUrl");
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("applied every migration successfully", async () => {
    const rows = await prisma.$queryRaw<{ name: string; finished: boolean; rolledBack: boolean }[]>`
      SELECT migration_name AS name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
      FROM _prisma_migrations ORDER BY migration_name`;
    expect(rows).toEqual([
      { name: "20261002000000_create_tenants", finished: true, rolledBack: false },
      { name: "20261002010000_create_companies", finished: true, rolledBack: false },
    ]);
  });

  it("creates only the expected tables", async () => {
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.name)).toEqual(["_prisma_migrations", "companies", "tenants"]);
  });

  it("creates the tenant_status enum with exactly the approved values", async () => {
    const labels = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'tenant_status' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED"]);
  });

  it("defines the tenants columns with the expected types and nullability", async () => {
    const columns = await prisma.$queryRaw<{ name: string; type: string; nullable: string }[]>`
      SELECT column_name AS name, format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable AS nullable
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = 'public.tenants'::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = 'tenants'
      ORDER BY c.ordinal_position`;
    expect(columns).toEqual([
      { name: "id", type: "uuid", nullable: "NO" },
      { name: "name", type: "text", nullable: "NO" },
      { name: "status", type: "tenant_status", nullable: "NO" },
      { name: "trial_started_at", type: "timestamp(3) with time zone", nullable: "YES" },
      { name: "trial_ends_at", type: "timestamp(3) with time zone", nullable: "YES" },
      { name: "created_at", type: "timestamp(3) with time zone", nullable: "NO" },
      { name: "updated_at", type: "timestamp(3) with time zone", nullable: "NO" },
    ]);
  });

  it("has id as primary key and no tenant_id column", async () => {
    const [pk] = await prisma.$queryRaw<{ name: string; columns: string }[]>`
      SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS columns
      FROM pg_constraint con WHERE con.conrelid = 'public.tenants'::regclass AND con.contype = 'p'`;
    expect(pk).toEqual({ name: "tenants_pkey", columns: "PRIMARY KEY (id)" });

    const [tenantId] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'tenant_id'`;
    expect(tenantId?.count).toBe(0n);
  });

  it("creates the company_status enum with exactly the approved values", async () => {
    const labels = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'company_status' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("defines the companies columns with the expected types and nullability", async () => {
    const columns = await prisma.$queryRaw<{ name: string; type: string; nullable: string }[]>`
      SELECT column_name AS name, format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable AS nullable
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = 'public.companies'::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = 'companies'
      ORDER BY c.ordinal_position`;
    expect(columns).toEqual([
      { name: "id", type: "uuid", nullable: "NO" },
      { name: "tenant_id", type: "uuid", nullable: "NO" },
      { name: "legal_name", type: "text", nullable: "NO" },
      { name: "trade_name", type: "text", nullable: "NO" },
      { name: "cnpj", type: "text", nullable: "NO" },
      { name: "status", type: "company_status", nullable: "NO" },
      { name: "timezone", type: "text", nullable: "NO" },
      { name: "created_at", type: "timestamp(3) with time zone", nullable: "NO" },
      { name: "updated_at", type: "timestamp(3) with time zone", nullable: "NO" },
    ]);
  });

  it("defines the companies constraints (PK, FK RESTRICT, CHECKs)", async () => {
    const constraints = await prisma.$queryRaw<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'public.companies'::regclass ORDER BY conname`;
    expect(constraints).toEqual([
      { name: "companies_cnpj_check", definition: "CHECK ((cnpj ~ '^[0-9]{14}$'::text))" },
      { name: "companies_legal_name_check", definition: "CHECK ((btrim(legal_name) <> ''::text))" },
      { name: "companies_pkey", definition: "PRIMARY KEY (id)" },
      {
        name: "companies_tenant_id_fkey",
        definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
      { name: "companies_trade_name_check", definition: "CHECK ((btrim(trade_name) <> ''::text))" },
    ]);
  });

  it("defines only the approved companies indexes", async () => {
    const indexes = await prisma.$queryRaw<{ name: string; definition: string }[]>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'companies' ORDER BY indexname`;
    expect(indexes.map((i) => [i.name, i.definition.replace(/^.* USING btree /, "")])).toEqual([
      ["companies_pkey", "(id)"],
      ["companies_tenant_id_cnpj_key", "(tenant_id, cnpj)"],
      ["companies_tenant_id_idx", "(tenant_id)"],
      ["companies_tenant_id_status_idx", "(tenant_id, status)"],
    ]);
    expect(indexes.find((i) => i.name === "companies_tenant_id_cnpj_key")?.definition).toMatch(/^CREATE UNIQUE INDEX/);
  });

  it("matches schema.prisma (no drift)", async () => {
    const diff = await runPrisma(
      ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"],
      databaseUrl,
    );
    expect(diff.code, diff.output).toBe(0);
  });
});
