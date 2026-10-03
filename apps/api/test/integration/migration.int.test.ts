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
      { name: "20261002020000_create_branches", finished: true, rolledBack: false },
      { name: "20261002030000_create_users", finished: true, rolledBack: false },
      { name: "20261002040000_create_user_branch_access", finished: true, rolledBack: false },
    ]);
  });

  it("creates only the expected tables", async () => {
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.name)).toEqual(["_prisma_migrations", "branches", "companies", "tenants", "user_branch_access", "users"]);
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
      ["companies_tenant_id_id_key", "(tenant_id, id)"],
      ["companies_tenant_id_idx", "(tenant_id)"],
      ["companies_tenant_id_status_idx", "(tenant_id, status)"],
    ]);
    expect(indexes.find((i) => i.name === "companies_tenant_id_cnpj_key")?.definition).toMatch(/^CREATE UNIQUE INDEX/);
  });

  it("creates the branch_status enum with exactly the approved values", async () => {
    const labels = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'branch_status' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("defines the branches columns with the expected types and nullability", async () => {
    const columns = await prisma.$queryRaw<{ name: string; type: string; nullable: string }[]>`
      SELECT column_name AS name, format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable AS nullable
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = 'public.branches'::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = 'branches'
      ORDER BY c.ordinal_position`;
    expect(columns).toEqual([
      { name: "id", type: "uuid", nullable: "NO" },
      { name: "tenant_id", type: "uuid", nullable: "NO" },
      { name: "company_id", type: "uuid", nullable: "NO" },
      { name: "name", type: "text", nullable: "NO" },
      { name: "code", type: "text", nullable: "NO" },
      { name: "cnpj", type: "text", nullable: "YES" },
      { name: "status", type: "branch_status", nullable: "NO" },
      { name: "timezone", type: "text", nullable: "NO" },
      { name: "created_at", type: "timestamp(3) with time zone", nullable: "NO" },
      { name: "updated_at", type: "timestamp(3) with time zone", nullable: "NO" },
    ]);
  });

  it("defines the branches constraints (PK, tenant FK, composite company FK, CHECKs)", async () => {
    const constraints = await prisma.$queryRaw<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'public.branches'::regclass ORDER BY conname`;
    expect(constraints).toEqual([
      { name: "branches_cnpj_check", definition: "CHECK (((cnpj IS NULL) OR (cnpj ~ '^[0-9]{14}$'::text)))" },
      { name: "branches_code_check", definition: "CHECK ((btrim(code) <> ''::text))" },
      { name: "branches_name_check", definition: "CHECK ((btrim(name) <> ''::text))" },
      { name: "branches_pkey", definition: "PRIMARY KEY (id)" },
      {
        name: "branches_tenant_id_company_id_fkey",
        definition:
          "FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
      {
        name: "branches_tenant_id_fkey",
        definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
    ]);
  });

  it("defines only the approved branches indexes (no standalone tenant_id index)", async () => {
    const indexes = await prisma.$queryRaw<{ name: string; definition: string }[]>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'branches' ORDER BY indexname`;
    expect(indexes.map((i) => i.definition.replace(/ ON public\.branches USING btree/, ""))).toEqual([
      "CREATE UNIQUE INDEX branches_pkey (id)",
      "CREATE UNIQUE INDEX branches_tenant_id_cnpj_key (tenant_id, cnpj)",
      "CREATE UNIQUE INDEX branches_tenant_id_code_key (tenant_id, code)",
      "CREATE INDEX branches_tenant_id_company_id_idx (tenant_id, company_id)",
      "CREATE UNIQUE INDEX branches_tenant_id_id_key (tenant_id, id)",
      "CREATE INDEX branches_tenant_id_status_idx (tenant_id, status)",
    ]);
  });

  it("creates the user_status enum with exactly the approved values", async () => {
    const labels = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'user_status' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(["ACTIVE", "DISABLED", "LOCKED"]);
  });

  it("defines the users columns with the expected types, nullability and defaults", async () => {
    const columns = await prisma.$queryRaw<{ name: string; type: string; nullable: string; default: string | null }[]>`
      SELECT column_name AS name, format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable AS nullable,
             c.column_default AS default
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = 'public.users'::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = 'users'
      ORDER BY c.ordinal_position`;
    expect(columns).toEqual([
      { name: "id", type: "uuid", nullable: "NO", default: null },
      { name: "tenant_id", type: "uuid", nullable: "NO", default: null },
      { name: "name", type: "text", nullable: "NO", default: null },
      { name: "employee_number", type: "text", nullable: "NO", default: null },
      { name: "password_hash", type: "text", nullable: "NO", default: null },
      { name: "status", type: "user_status", nullable: "NO", default: null },
      { name: "must_change_password", type: "boolean", nullable: "NO", default: "false" },
      { name: "failed_login_attempts", type: "integer", nullable: "NO", default: "0" },
      { name: "locked_until", type: "timestamp(3) with time zone", nullable: "YES", default: null },
      { name: "last_login_at", type: "timestamp(3) with time zone", nullable: "YES", default: null },
      { name: "disabled_at", type: "timestamp(3) with time zone", nullable: "YES", default: null },
      { name: "created_at", type: "timestamp(3) with time zone", nullable: "NO", default: "CURRENT_TIMESTAMP" },
      { name: "updated_at", type: "timestamp(3) with time zone", nullable: "NO", default: null },
    ]);
  });

  it("defines the users constraints (PK, tenant FK, CHECKs)", async () => {
    const constraints = await prisma.$queryRaw<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'public.users'::regclass ORDER BY conname`;
    expect(constraints).toEqual([
      { name: "users_employee_number_check", definition: "CHECK ((btrim(employee_number) <> ''::text))" },
      { name: "users_failed_login_attempts_check", definition: "CHECK ((failed_login_attempts >= 0))" },
      { name: "users_name_check", definition: "CHECK ((btrim(name) <> ''::text))" },
      { name: "users_password_hash_check", definition: "CHECK ((btrim(password_hash) <> ''::text))" },
      { name: "users_pkey", definition: "PRIMARY KEY (id)" },
      {
        name: "users_tenant_id_fkey",
        definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
    ]);
  });

  it("defines only the approved users indexes", async () => {
    const indexes = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users' ORDER BY indexname`;
    expect(indexes.map((i) => i.definition.replace(/ ON public\.users USING btree/, ""))).toEqual([
      "CREATE UNIQUE INDEX users_pkey (id)",
      "CREATE UNIQUE INDEX users_tenant_id_employee_number_key (tenant_id, employee_number)",
      "CREATE UNIQUE INDEX users_tenant_id_id_key (tenant_id, id)",
      "CREATE INDEX users_tenant_id_status_idx (tenant_id, status)",
    ]);
  });

  it("defines the user_branch_access columns (no updated_at, no status)", async () => {
    const columns = await prisma.$queryRaw<{ name: string; type: string; nullable: string }[]>`
      SELECT column_name AS name, format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable AS nullable
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = 'public.user_branch_access'::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = 'user_branch_access'
      ORDER BY c.ordinal_position`;
    expect(columns).toEqual([
      { name: "id", type: "uuid", nullable: "NO" },
      { name: "tenant_id", type: "uuid", nullable: "NO" },
      { name: "user_id", type: "uuid", nullable: "NO" },
      { name: "branch_id", type: "uuid", nullable: "NO" },
      { name: "created_at", type: "timestamp(3) with time zone", nullable: "NO" },
    ]);
  });

  it("defines the user_branch_access constraints (PK, tenant FK, composite user/branch FKs)", async () => {
    const constraints = await prisma.$queryRaw<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'public.user_branch_access'::regclass ORDER BY conname`;
    expect(constraints).toEqual([
      { name: "user_branch_access_pkey", definition: "PRIMARY KEY (id)" },
      {
        name: "user_branch_access_tenant_id_branch_id_fkey",
        definition:
          "FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
      {
        name: "user_branch_access_tenant_id_fkey",
        definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
      {
        name: "user_branch_access_tenant_id_user_id_fkey",
        definition: "FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
    ]);
  });

  it("defines only the approved user_branch_access indexes", async () => {
    const indexes = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'user_branch_access' ORDER BY indexname`;
    expect(indexes.map((i) => i.definition.replace(/ ON public\.user_branch_access USING btree/, ""))).toEqual([
      "CREATE UNIQUE INDEX user_branch_access_pkey (id)",
      "CREATE INDEX user_branch_access_tenant_id_branch_id_idx (tenant_id, branch_id)",
      "CREATE UNIQUE INDEX user_branch_access_tenant_id_user_id_branch_id_key (tenant_id, user_id, branch_id)",
    ]);
  });

  it("matches schema.prisma (no drift)", async () => {
    const diff = await runPrisma(
      ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"],
      databaseUrl,
    );
    expect(diff.code, diff.output).toBe(0);
  });
});
