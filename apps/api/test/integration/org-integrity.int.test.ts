import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  RoleStatus,
  TenantStatus,
  UserStatus,
  type Company,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";
import {
  GLOBAL_TABLES,
  HASHED_CREDENTIAL_COLUMNS,
  ROOT_TABLE,
  SPECIAL_TENANT_ID_POLICIES,
  classifyTable,
  credentialColumnViolations,
  foreignKeyViolations,
  inRolledBackTransaction,
  listTables,
  tenantIdImmutabilityViolations,
  tenantIdTriggerDefinition,
  tenantScopeViolations,
  tenantScopedTables,
} from "./table-audit.js";

// Multi-tenant structural integrity (M1.4-M1.12): tenant tables, explicit global tables, Prisma tooling.
// Per-entity behaviour (creation, uniqueness, CHECKs) lives in the per-model tests.

const CROSS_TENANT_FK = /branches_tenant_id_company_id_fkey/;

describe("Tenant -> Company -> Branch integrity (PostgreSQL)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("catalog audit", () => {
    it("classifies every table explicitly (guards against an empty audit)", async () => {
      const kinds = Object.fromEntries((await listTables(prisma)).map((t) => [t, classifyTable(t)]));
      expect(kinds).toEqual({
        _prisma_migrations: "tooling",
        audit_logs: "tenant",
        branches: "tenant",
        companies: "tenant",
        devices: "tenant",
        permissions: "global",
        role_permissions: "tenant",
        roles: "tenant",
        sessions: "tenant",
        tenants: "root",
        user_branch_access: "tenant",
        user_roles: "tenant",
        users: "tenant",
      });
    });

    it("declares permissions as the only global table", () => {
      expect(GLOBAL_TABLES).toEqual(["permissions"]);
    });

    it("reports no tenant-scope violation in the migrated schema", async () => {
      expect(await tenantScopeViolations(prisma)).toEqual([]);
    });

    it("fails closed: an undeclared table without tenant_id is reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "audit_probe_global" ("id" uuid PRIMARY KEY, "code" text NOT NULL)`);
        return tenantScopeViolations(tx);
      });
      expect(violations).toEqual([
        "audit_probe_global: missing tenant_id (declare it as global if intended)",
        "audit_probe_global: missing FK tenant_id -> tenants(id)",
      ]);
    });

    it("fails closed: a tenant table with nullable tenant_id and no tenant FK is reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "audit_probe_tenant" ("id" uuid PRIMARY KEY, "tenant_id" uuid)`);
        return tenantScopeViolations(tx);
      });
      expect(violations).toEqual([
        "audit_probe_tenant: tenant_id must be uuid NOT NULL",
        "audit_probe_tenant: missing FK tenant_id -> tenants(id)",
      ]);
    });

    it("rolls the probes back (no probe table left behind)", async () => {
      expect((await listTables(prisma)).filter((t) => t.startsWith("audit_probe"))).toEqual([]);
    });

    it("covers every tenant-scoped table", async () => {
      expect(await tenantScopedTables(prisma)).toEqual([
        "audit_logs",
        "branches",
        "companies",
        "devices",
        "role_permissions",
        "roles",
        "sessions",
        "user_branch_access",
        "user_roles",
        "users",
      ]);
    });

    it("keeps global tables free of tenant_id and of FKs to tenants", async () => {
      const rows = await prisma.$queryRaw<{ table: string; tenantId: boolean; tenantFk: boolean }[]>`
        SELECT t.relname AS "table",
               EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'tenant_id'
                       AND NOT a.attisdropped) AS "tenantId",
               EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = t.oid AND con.contype = 'f'
                       AND con.confrelid = 'public.tenants'::regclass) AS "tenantFk"
        FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND t.relkind = 'r' AND t.relname = ANY(${[...GLOBAL_TABLES]}::text[])
        ORDER BY t.relname`;
      expect(rows).toEqual(GLOBAL_TABLES.map((table) => ({ table, tenantId: false, tenantFk: false })));
    });

    it("keeps tenants as the root, without tenant_id", async () => {
      const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${ROOT_TABLE} AND column_name = 'tenant_id'`;
      expect(row?.count).toBe(0n);
    });

    it("gives every non-root table a NOT NULL uuid tenant_id", async () => {
      const rows = await prisma.$queryRaw<{ table: string; type: string | null; nullable: string | null }[]>`
        SELECT t.table_name AS "table", c.data_type AS type, c.is_nullable AS nullable
        FROM information_schema.tables t
        LEFT JOIN information_schema.columns c
          ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant_id'
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`;
      const scoped = new Set(await tenantScopedTables(prisma));

      for (const row of rows.filter((r) => scoped.has(r.table))) {
        expect(row, row.table).toEqual({ table: row.table, type: "uuid", nullable: "NO" });
      }
    });

    it("gives every non-root table a direct FK tenant_id -> tenants(id)", async () => {
      const rows = await prisma.$queryRaw<{ table: string }[]>`
        SELECT cl.relname AS "table"
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND con.contype = 'f' AND con.confrelid = 'public.tenants'::regclass
          AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)%'
        ORDER BY cl.relname`;
      expect(rows.map((r) => r.table)).toEqual(await tenantScopedTables(prisma));
    });

    it("has exactly the expected FKs, including the composite tenant-carrying FKs", async () => {
      const rows = await prisma.$queryRaw<{ name: string; definition: string }[]>`
        SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE n.nspname = 'public' AND con.contype = 'f' ORDER BY con.conname`;
      expect(rows).toEqual([
        {
          name: "audit_logs_tenant_id_branch_id_fkey",
          definition: "FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "audit_logs_tenant_id_device_id_fkey",
          definition: "FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "audit_logs_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "audit_logs_tenant_id_user_id_fkey",
          definition: "FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "branches_tenant_id_company_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "branches_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "companies_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "devices_tenant_id_branch_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "devices_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "role_permissions_permission_id_fkey",
          definition: "FOREIGN KEY (permission_id) REFERENCES permissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "role_permissions_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "role_permissions_tenant_id_role_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "roles_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "sessions_tenant_id_device_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "sessions_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "sessions_tenant_id_user_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
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
          definition:
            "FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "user_roles_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "user_roles_tenant_id_role_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "user_roles_tenant_id_user_id_branch_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, user_id, branch_id) REFERENCES user_branch_access(tenant_id, user_id, branch_id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "user_roles_tenant_id_user_id_fkey",
          definition:
            "FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
        {
          name: "users_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
      ]);
    });

    it("allows only the explicitly listed hashed credential columns", () => {
      expect(HASHED_CREDENTIAL_COLUMNS).toEqual(["sessions.refresh_token_hash", "users.password_hash"]);
      for (const column of HASHED_CREDENTIAL_COLUMNS) expect(column).toMatch(/_hash$/);
    });

    it("stores no plain-text credential column (password, token, secret, keys, pin)", async () => {
      expect(await credentialColumnViolations(prisma)).toEqual([]);
    });

    it("probe: plain-text credential columns are reported; the hash allowlist is table-specific", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE TABLE "audit_probe_tokens" (
            "id" uuid PRIMARY KEY,
            "refresh_token" text, "access_token" text, "token" text, "api_key" text, "apikey" varchar(64),
            "private_key" text, "client_secret" text, "senha" text, "pin" text,
            "refresh_token_hash" text, "must_change_password" boolean, "device_key" text
          )`);
        return credentialColumnViolations(tx);
      });
      expect(violations).toEqual([
        "audit_probe_tokens.access_token",
        "audit_probe_tokens.api_key",
        "audit_probe_tokens.apikey",
        "audit_probe_tokens.client_secret",
        "audit_probe_tokens.pin",
        "audit_probe_tokens.private_key",
        "audit_probe_tokens.refresh_token",
        "audit_probe_tokens.refresh_token_hash",
        "audit_probe_tokens.senha",
        "audit_probe_tokens.token",
      ]);
    });

    it("uses no CASCADE / SET NULL / SET DEFAULT on any FK", async () => {
      // r = RESTRICT, a = NO ACTION; c = CASCADE, n = SET NULL, d = SET DEFAULT
      const rows = await prisma.$queryRaw<{ name: string; onDelete: string; onUpdate: string }[]>`
        SELECT con.conname AS name, con.confdeltype::text AS "onDelete", con.confupdtype::text AS "onUpdate"
        FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE n.nspname = 'public' AND con.contype = 'f'`;

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(["r", "a"], `${row.name} ON DELETE`).toContain(row.onDelete);
        expect(["r", "a"], `${row.name} ON UPDATE`).toContain(row.onUpdate);
      }
    });

    it("classifies every FK by the kind of its target table", async () => {
      const rows = await prisma.$queryRaw<{ name: string; child: string; parent: string }[]>`
        SELECT con.conname AS name, cl.relname AS child, pr.relname AS parent
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_class pr ON pr.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND con.contype = 'f' AND con.confrelid <> 'public.tenants'::regclass
        ORDER BY con.conname`;
      expect(rows.map((r) => [r.name, `${classifyTable(r.child)} -> ${classifyTable(r.parent)}`])).toEqual([
        ["audit_logs_tenant_id_branch_id_fkey", "tenant -> tenant"],
        ["audit_logs_tenant_id_device_id_fkey", "tenant -> tenant"],
        ["audit_logs_tenant_id_user_id_fkey", "tenant -> tenant"],
        ["branches_tenant_id_company_id_fkey", "tenant -> tenant"],
        ["devices_tenant_id_branch_id_fkey", "tenant -> tenant"],
        ["role_permissions_permission_id_fkey", "tenant -> global"],
        ["role_permissions_tenant_id_role_id_fkey", "tenant -> tenant"],
        ["sessions_tenant_id_device_id_fkey", "tenant -> tenant"],
        ["sessions_tenant_id_user_id_fkey", "tenant -> tenant"],
        ["user_branch_access_tenant_id_branch_id_fkey", "tenant -> tenant"],
        ["user_branch_access_tenant_id_user_id_fkey", "tenant -> tenant"],
        ["user_roles_tenant_id_role_id_fkey", "tenant -> tenant"],
        ["user_roles_tenant_id_user_id_branch_id_fkey", "tenant -> tenant"],
        ["user_roles_tenant_id_user_id_fkey", "tenant -> tenant"],
      ]);
    });

    it("keeps tenant_id NOT NULL in every FK that carries it (MATCH SIMPLE would skip a NULL tenant_id)", async () => {
      const rows = await prisma.$queryRaw<{ name: string; match: string; nullableColumns: string[] }[]>`
        SELECT con.conname AS name, con.confmatchtype::text AS match,
               COALESCE(array_agg(a.attname::text ORDER BY a.attname) FILTER (WHERE NOT a.attnotnull), '{}') AS "nullableColumns"
        FROM pg_constraint con
        JOIN pg_namespace n ON n.oid = con.connamespace
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
        WHERE n.nspname = 'public' AND con.contype = 'f' AND array_length(con.conkey, 1) > 1
        GROUP BY con.conname, con.confmatchtype
        ORDER BY con.conname`;

      for (const row of rows) expect(row.nullableColumns, row.name).not.toContain("tenant_id");
      // Composite FKs with a nullable column: only the optional user/branch/device links (MATCH SIMPLE, NULL = none).
      expect(rows.filter((r) => r.nullableColumns.length > 0)).toEqual([
        { name: "audit_logs_tenant_id_branch_id_fkey", match: "s", nullableColumns: ["branch_id"] },
        { name: "audit_logs_tenant_id_device_id_fkey", match: "s", nullableColumns: ["device_id"] },
        { name: "audit_logs_tenant_id_user_id_fkey", match: "s", nullableColumns: ["user_id"] },
        { name: "devices_tenant_id_branch_id_fkey", match: "s", nullableColumns: ["branch_id"] },
        { name: "sessions_tenant_id_device_id_fkey", match: "s", nullableColumns: ["device_id"] },
        { name: "user_roles_tenant_id_user_id_branch_id_fkey", match: "s", nullableColumns: ["branch_id"] },
      ]);
    });

    it("reports no FK violation: tenant -> tenant FKs carry tenant_id, tenant -> global FKs may be simple", async () => {
      expect(await foreignKeyViolations(prisma)).toEqual([]);
    });

    it("probe: a simple FK from a tenant table to another tenant table is rejected", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE TABLE "audit_probe_fk" (
            "id" uuid PRIMARY KEY,
            "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
            "role_id" uuid NOT NULL REFERENCES "roles"("id")
          )`);
        return foreignKeyViolations(tx);
      });
      expect(violations).toEqual(["audit_probe_fk_role_id_fkey: FK to tenant table roles must include tenant_id on both sides"]);
    });

    it("probe: a simple FK from a tenant table to a declared global table is accepted", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE TABLE "audit_probe_fk" (
            "id" uuid PRIMARY KEY,
            "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
            "permission_id" uuid NOT NULL REFERENCES "permissions"("id")
          )`);
        return [...(await foreignKeyViolations(tx)), ...(await tenantScopeViolations(tx))];
      });
      expect(violations).toEqual([]);
    });

    it("probe: the same simple FK is rejected when the target is not declared global", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "audit_probe_catalog" ("id" uuid PRIMARY KEY)`);
        await tx.$executeRawUnsafe(`
          CREATE TABLE "audit_probe_fk" (
            "id" uuid PRIMARY KEY,
            "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
            "catalog_id" uuid NOT NULL REFERENCES "audit_probe_catalog"("id")
          )`);
        return foreignKeyViolations(tx);
      });
      expect(violations).toEqual([
        "audit_probe_fk_catalog_id_fkey: FK to tenant table audit_probe_catalog must include tenant_id on both sides",
      ]);
    });

    it("probe: a global table must not reference tenant data", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE TABLE "audit_probe_catalog" ("id" uuid PRIMARY KEY, "role_id" uuid REFERENCES "roles"("id"))`);
        return foreignKeyViolations(tx, [...GLOBAL_TABLES, "audit_probe_catalog"]);
      });
      expect(violations).toEqual(["audit_probe_catalog_role_id_fkey: global table must not reference tenant table roles"]);
    });
  });

  describe("tenant_id immutability audit (M1.14.1)", () => {
    const PROBE = "audit_probe_tenant_imm";
    const createProbe = `CREATE TABLE "${PROBE}" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE RESTRICT)`;

    it("reports no violation in the migrated schema", async () => {
      expect(await tenantIdImmutabilityViolations(prisma)).toEqual([]);
    });

    it("declares audit_logs as the only tenant table with a special policy (append-only)", () => {
      expect(SPECIAL_TENANT_ID_POLICIES).toEqual({
        audit_logs: { policy: "append-only", trigger: "audit_logs_append_only", fn: "forbid_audit_log_mutation" },
      });
    });

    it("protects every editable tenant table with exactly the approved trigger", async () => {
      const editable = (await tenantScopedTables(prisma)).filter((t) => !(t in SPECIAL_TENANT_ID_POLICIES));
      const rows = await prisma.$queryRaw<{ table: string; enabled: string; definition: string }[]>`
        SELECT c.relname::text AS "table", t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgfoid = 'public.forbid_tenant_id_change()'::regprocedure
        ORDER BY c.relname`;

      expect(editable).toEqual([
        "branches",
        "companies",
        "devices",
        "role_permissions",
        "roles",
        "sessions",
        "user_branch_access",
        "user_roles",
        "users",
      ]);
      expect(rows).toEqual(editable.map((table) => ({ table, enabled: "O", definition: tenantIdTriggerDefinition(table) })));
    });

    it("defines forbid_tenant_id_change() as a shared plpgsql trigger function without table-specific arguments", async () => {
      const rows = await prisma.$queryRaw<{ returns: string; language: string; args: string; body: string }[]>`
        SELECT format_type(p.prorettype, NULL) AS returns, l.lanname::text AS language,
               pg_get_function_identity_arguments(p.oid) AS args, p.prosrc AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.proname = 'forbid_tenant_id_change'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ returns: "trigger", language: "plpgsql", args: "" });
      // Not coupled to table names: it reports TG_TABLE_NAME and re-checks the change itself.
      expect(rows[0]?.body).toContain("TG_TABLE_NAME");
      expect(rows[0]?.body).toContain("NEW.tenant_id IS DISTINCT FROM OLD.tenant_id");
      for (const table of await tenantScopedTables(prisma)) expect(rows[0]?.body).not.toContain(table);
    });

    it("fails closed: a new tenant table without the trigger is reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([`${PROBE}: missing tenant_id immutability trigger (${PROBE}_tenant_id_immutable)`]);
    });

    it("accepts a new tenant table with the approved trigger", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "${PROBE}_tenant_id_immutable" BEFORE UPDATE OF "tenant_id" ON "${PROBE}"
          FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id") EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([]);
    });

    it.each([
      [
        "AFTER instead of BEFORE",
        `AFTER UPDATE OF "tenant_id" ON "${PROBE}" FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")`,
        [`${PROBE}: ${PROBE}_tenant_id_immutable must be BEFORE`],
      ],
      [
        "per statement",
        `BEFORE UPDATE OF "tenant_id" ON "${PROBE}" FOR EACH STATEMENT`,
        [`${PROBE}: ${PROBE}_tenant_id_immutable must be FOR EACH ROW`],
      ],
      [
        "any column, no WHEN",
        `BEFORE UPDATE ON "${PROBE}" FOR EACH ROW`,
        [`${PROBE}: ${PROBE}_tenant_id_immutable must be UPDATE OF tenant_id`],
      ],
      [
        "missing WHEN",
        `BEFORE UPDATE OF "tenant_id" ON "${PROBE}" FOR EACH ROW`,
        [],
      ],
      [
        "also on DELETE",
        `BEFORE UPDATE OF "tenant_id" OR DELETE ON "${PROBE}" FOR EACH ROW`,
        [`${PROBE}: ${PROBE}_tenant_id_immutable must fire on UPDATE only`],
      ],
    ])("reports a trigger %s", async (_, timing, expected) => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "${PROBE}_tenant_id_immutable" ${timing} EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([...expected, `${PROBE}: ${PROBE}_tenant_id_immutable differs from the approved definition`]);
    });

    it("reports a disabled trigger", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "${PROBE}_tenant_id_immutable" BEFORE UPDATE OF "tenant_id" ON "${PROBE}"
          FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id") EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        await tx.$executeRawUnsafe(`ALTER TABLE "${PROBE}" DISABLE TRIGGER "${PROBE}_tenant_id_immutable"`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([`${PROBE}: ${PROBE}_tenant_id_immutable must be enabled`]);
    });

    it("reports a trigger with another name", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "probe_guard" BEFORE UPDATE OF "tenant_id" ON "${PROBE}"
          FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id") EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([
        `${PROBE}: trigger probe_guard must be named ${PROBE}_tenant_id_immutable`,
        `${PROBE}: probe_guard differs from the approved definition`,
      ]);
    });

    it("verifies the append-only policy of audit_logs instead of exempting it silently", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "audit_logs_tenant_id_immutable" BEFORE UPDATE OF "tenant_id" ON "audit_logs"
          FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id") EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([
        "audit_logs: append-only table must not use the generic tenant_id trigger",
        "audit_logs: audit_logs_append_only must be an enabled BEFORE UPDATE OR DELETE row trigger calling forbid_audit_log_mutation()",
      ]);

      const missing = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`DROP TRIGGER audit_logs_append_only ON audit_logs`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(missing).toEqual(["audit_logs: missing append-only trigger audit_logs_append_only"]);
    });

    it("reports either trigger function used on the wrong table", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "${PROBE}_tenant_id_immutable" BEFORE UPDATE OF "tenant_id" ON "${PROBE}"
          FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id") EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        await tx.$executeRawUnsafe(`CREATE TRIGGER "probe_append_only" BEFORE UPDATE OR DELETE ON "${PROBE}"
          FOR EACH ROW EXECUTE FUNCTION "forbid_audit_log_mutation"()`);
        // permissions is global: it has no tenant_id, so the trigger targets a column it does not have (code).
        await tx.$executeRawUnsafe(`CREATE TRIGGER "probe_misuse" BEFORE UPDATE OF "code" ON "permissions"
          FOR EACH ROW EXECUTE FUNCTION "forbid_tenant_id_change"()`);
        return tenantIdImmutabilityViolations(tx);
      });
      expect(violations).toEqual([
        "permissions: non-tenant table must not use forbid_tenant_id_change()",
        `${PROBE}: forbid_audit_log_mutation() is specific to audit_logs`,
      ]);
    });
  });

  describe("tenant_id changes", () => {
    async function newTenant(name: string) {
      return prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
    }

    async function newCompany(tenantId: string, cnpj = "11222333000181"): Promise<Company> {
      return prisma.company.create({
        data: {
          tenantId,
          legalName: "Empresa Ltda",
          tradeName: "Empresa",
          cnpj,
          status: CompanyStatus.ACTIVE,
          timezone: "America/Sao_Paulo",
        },
      });
    }

    function newBranch(company: Company, code = "MORUMBI") {
      return prisma.branch.create({
        data: {
          tenantId: company.tenantId,
          companyId: company.id,
          name: "Filial",
          code,
          status: BranchStatus.ACTIVE,
          timezone: "America/Sao_Paulo",
        },
      });
    }

    /** Every branch must belong to its company's tenant (global invariant). */
    async function crossTenantBranches(): Promise<bigint> {
      const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM branches b JOIN companies c ON c.id = b.company_id
        WHERE c.tenant_id <> b.tenant_id`;
      return row?.count ?? -1n;
    }

    it("blocks a branch tenant_id change alone (Prisma and SQL)", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const other = await newTenant("B");
      const branch = await newBranch(company);

      await expectTenantIdImmutable(prisma.branch.update({ where: { id: branch.id }, data: { tenantId: other.id } }), "branches");
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${other.id}::uuid WHERE id = ${branch.id}::uuid`,
        "branches",
      );
      expect((await prisma.branch.findUniqueOrThrow({ where: { id: branch.id } })).tenantId).toBe(company.tenantId);
    });

    it("blocks a branch company_id change to another tenant's company (Prisma and SQL)", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const foreign = await newCompany((await newTenant("B")).id);
      const branch = await newBranch(company);

      await expect(
        prisma.branch.update({ where: { id: branch.id }, data: { companyId: foreign.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.$executeRaw`UPDATE branches SET company_id = ${foreign.id}::uuid WHERE id = ${branch.id}::uuid`,
      ).rejects.toThrow(CROSS_TENANT_FK);
    });

    it("blocks a company tenant_id change while it has branches (Prisma and SQL)", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const other = await newTenant("B");
      await newBranch(company);

      await expectTenantIdImmutable(prisma.company.update({ where: { id: company.id }, data: { tenantId: other.id } }), "companies");
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE companies SET tenant_id = ${other.id}::uuid WHERE id = ${company.id}::uuid`,
        "companies",
      );
    });

    it("blocks a company tenant_id change to a non-existent tenant (immutability fires before the FK)", async () => {
      const company = await newCompany((await newTenant("A")).id);

      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE companies SET tenant_id = gen_random_uuid() WHERE id = ${company.id}::uuid`,
        "companies",
      );
    });

    // Formerly GAP (M1.14): consistent moves were accepted; companies/branches_tenant_id_immutable now forbid them.
    it("blocks moving a branch when tenant_id and company_id change together (Prisma and SQL)", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const target = await newCompany((await newTenant("B")).id);
      const branch = await newBranch(company);

      await expectTenantIdImmutable(
        prisma.branch.update({ where: { id: branch.id }, data: { tenantId: target.tenantId, companyId: target.id } }),
        "branches",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${target.tenantId}::uuid, company_id = ${target.id}::uuid
                           WHERE id = ${branch.id}::uuid`,
        "branches",
      );
      expect(await prisma.branch.findUniqueOrThrow({ where: { id: branch.id } })).toMatchObject({
        tenantId: company.tenantId,
        companyId: company.id,
      });
      expect(await crossTenantBranches()).toBe(0n);
    });

    it("blocks moving a company without branches to another tenant (Prisma and SQL)", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const other = await newTenant("B");

      await expectTenantIdImmutable(prisma.company.update({ where: { id: company.id }, data: { tenantId: other.id } }), "companies");
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE companies SET tenant_id = ${other.id}::uuid WHERE id = ${company.id}::uuid`,
        "companies",
      );
      expect((await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).tenantId).toBe(company.tenantId);
    });
  });

  describe("tenant_id changes (User)", () => {
    async function newUser(name: string) {
      const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
      return prisma.user.create({
        data: { tenantId: tenant.id, name: "U", employeeNumber: "1001", passwordHash: "x", status: UserStatus.ACTIVE },
      });
    }

    it("blocks a user tenant_id change to a non-existent tenant (immutability fires before the FK)", async () => {
      const user = await newUser("A");

      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE users SET tenant_id = gen_random_uuid() WHERE id = ${user.id}::uuid`,
        "users",
      );
    });

    // Formerly GAP (M1.14).
    it("blocks moving a user without links to another existing tenant (Prisma and SQL)", async () => {
      const user = await newUser("A");
      const other = await prisma.tenant.create({ data: { name: "B", status: TenantStatus.ACTIVE } });

      await expectTenantIdImmutable(prisma.user.update({ where: { id: user.id }, data: { tenantId: other.id } }), "users");
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE users SET tenant_id = ${other.id}::uuid WHERE id = ${user.id}::uuid`,
        "users",
      );
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).tenantId).toBe(user.tenantId);
    });
  });

  describe("tenant_id changes (Role)", () => {
    async function newRole(name: string) {
      const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
      return prisma.role.create({ data: { tenantId: tenant.id, code: "OWNER", name: "Proprietário", status: RoleStatus.ACTIVE } });
    }

    it("blocks a role tenant_id change to a non-existent tenant (immutability fires before the FK)", async () => {
      const role = await newRole("A");

      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE roles SET tenant_id = gen_random_uuid() WHERE id = ${role.id}::uuid`,
        "roles",
      );
    });

    // Formerly GAP (M1.14).
    it("blocks moving a role without links to another existing tenant (Prisma and SQL)", async () => {
      const role = await newRole("A");
      const other = await prisma.tenant.create({ data: { name: "B", status: TenantStatus.ACTIVE } });

      await expectTenantIdImmutable(prisma.role.update({ where: { id: role.id }, data: { tenantId: other.id } }), "roles");
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE roles SET tenant_id = ${other.id}::uuid WHERE id = ${role.id}::uuid`,
        "roles",
      );
      expect((await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).tenantId).toBe(role.tenantId);
    });
  });

  describe("tenant_id changes (RolePermission)", () => {
    async function newRole(name: string) {
      const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
      return prisma.role.create({ data: { tenantId: tenant.id, code: "OWNER", name: "Proprietário", status: RoleStatus.ACTIVE } });
    }

    async function anyPermission() {
      const module = `t${Math.random().toString(16).slice(2, 10)}`;
      return prisma.permission.create({ data: { code: `${module}.read`, module, description: "Teste" } });
    }

    it("blocks moving a role that has permissions to another tenant", async () => {
      const role = await newRole("A");
      const other = await prisma.tenant.create({ data: { name: "B", status: TenantStatus.ACTIVE } });
      await prisma.rolePermission.create({
        data: { tenantId: role.tenantId, roleId: role.id, permissionId: (await anyPermission()).id },
      });

      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE roles SET tenant_id = ${other.id}::uuid WHERE id = ${role.id}::uuid`,
        "roles",
      );
    });

    // Formerly GAP (M1.14).
    it("blocks moving a role-permission when tenant_id and role_id change together (Prisma and SQL)", async () => {
      const roleA = await newRole("A");
      const roleB = await newRole("B");
      const link = await prisma.rolePermission.create({
        data: { tenantId: roleA.tenantId, roleId: roleA.id, permissionId: (await anyPermission()).id },
      });

      await expectTenantIdImmutable(
        prisma.rolePermission.update({ where: { id: link.id }, data: { tenantId: roleB.tenantId, roleId: roleB.id } }),
        "role_permissions",
      );
      await expectTenantIdImmutable(
        prisma.$executeRaw`UPDATE role_permissions SET tenant_id = ${roleB.tenantId}::uuid, role_id = ${roleB.id}::uuid
                           WHERE id = ${link.id}::uuid`,
        "role_permissions",
      );
      expect(await prisma.rolePermission.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({
        tenantId: roleA.tenantId,
        roleId: roleA.id,
      });
    });
  });

  describe("no cascade delete", () => {
    it("keeps tenant, company and branch when deleting the tenant fails", async () => {
      const tenant = await prisma.tenant.create({ data: { name: "Raiz", status: TenantStatus.ACTIVE } });
      const company = await prisma.company.create({
        data: {
          tenantId: tenant.id,
          legalName: "Empresa Ltda",
          tradeName: "Empresa",
          cnpj: "11222333000181",
          status: CompanyStatus.ACTIVE,
          timezone: "America/Sao_Paulo",
        },
      });
      const branch = await prisma.branch.create({
        data: {
          tenantId: tenant.id,
          companyId: company.id,
          name: "Filial",
          code: "MORUMBI",
          status: BranchStatus.ACTIVE,
          timezone: "America/Sao_Paulo",
        },
      });

      await expect(prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenant.id}::uuid`).rejects.toThrow(
        /violates foreign key constraint/,
      );
      await expect(prisma.$executeRaw`DELETE FROM companies WHERE id = ${company.id}::uuid`).rejects.toThrow(
        CROSS_TENANT_FK,
      );

      expect(await prisma.tenant.findUnique({ where: { id: tenant.id } })).not.toBeNull();
      expect(await prisma.company.findUnique({ where: { id: company.id } })).not.toBeNull();
      expect(await prisma.branch.findUnique({ where: { id: branch.id } })).not.toBeNull();
    });
  });
});
