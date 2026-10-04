import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import {
  FK_COVERAGE_EXCEPTIONS,
  KNOWN_REDUNDANT_INDEXES,
  MANUAL_CHECK_CONSTRAINTS,
  MANUAL_PARTIAL_INDEXES,
  checkConstraintViolations,
  compositeFkTargetViolations,
  foreignKeyCoverageViolations,
  inRolledBackTransaction,
  listIndexes,
  partialIndexViolations,
  redundantIndexViolations,
} from "./table-audit.js";

// M1.14.3: physical schema hardening. The catalog is the source of truth: Prisma does not represent partial indexes,
// CHECKs, functions, triggers, ACLs or ownership, and `migrate diff` does not notice when they go missing.
// Exact per-table definitions stay in migration.int.test.ts; this file holds the schema-wide, fail-closed rules.
describe("schema hardening (PostgreSQL catalog)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(inject("databaseUrl"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const PROBE = "audit_probe_hardening";
  const createProbe = `CREATE TABLE "${PROBE}" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL, "role_id" uuid NOT NULL)`;

  describe("index inventory", () => {
    it("has exactly the approved indexes, all B-tree, per table", async () => {
      const indexes = await listIndexes(prisma);
      const byTable: Record<string, string[]> = {};
      for (const i of indexes) (byTable[i.table] ??= []).push(i.name);

      expect(byTable).toEqual({
        _prisma_migrations: ["_prisma_migrations_pkey"],
        audit_logs: [
          "audit_logs_pkey",
          "audit_logs_tenant_id_branch_id_created_at_idx",
          "audit_logs_tenant_id_created_at_idx",
          "audit_logs_tenant_id_device_id_created_at_idx",
          "audit_logs_tenant_id_resource_type_resource_id_created_at_idx",
          "audit_logs_tenant_id_user_id_created_at_idx",
        ],
        branches: [
          "branches_pkey",
          "branches_tenant_id_cnpj_key",
          "branches_tenant_id_code_key",
          "branches_tenant_id_company_id_idx",
          "branches_tenant_id_id_key",
          "branches_tenant_id_status_idx",
        ],
        companies: ["companies_pkey", "companies_tenant_id_cnpj_key", "companies_tenant_id_id_key", "companies_tenant_id_status_idx"],
        devices: [
          "devices_pkey",
          "devices_tenant_id_branch_id_idx",
          "devices_tenant_id_device_key_key",
          "devices_tenant_id_id_key",
          "devices_tenant_id_status_idx",
        ],
        permissions: ["permissions_code_key", "permissions_module_idx", "permissions_pkey"],
        role_permissions: ["role_permissions_permission_id_idx", "role_permissions_pkey", "role_permissions_tenant_id_role_id_permission_id_key"],
        roles: ["roles_pkey", "roles_tenant_id_code_key", "roles_tenant_id_id_key", "roles_tenant_id_status_idx"],
        sessions: ["sessions_pkey", "sessions_refresh_token_hash_key", "sessions_tenant_id_device_id_idx", "sessions_tenant_id_user_id_idx"],
        tenants: ["tenants_pkey"],
        user_branch_access: [
          "user_branch_access_pkey",
          "user_branch_access_tenant_id_branch_id_idx",
          "user_branch_access_tenant_id_user_id_branch_id_key",
        ],
        user_roles: [
          "user_roles_branch_scope_key",
          "user_roles_pkey",
          "user_roles_tenant_id_role_id_idx",
          "user_roles_tenant_id_user_id_branch_id_idx",
          "user_roles_tenant_scope_key",
        ],
        users: ["users_pkey", "users_tenant_id_employee_number_key", "users_tenant_id_id_key", "users_tenant_id_status_idx"],
      });
      expect(indexes.filter((i) => i.method !== "btree" || !i.valid || i.expression)).toEqual([]);
    });

    it("keeps every tenant-scoped index tenant-leading; only the approved global indexes are not", async () => {
      const indexes = await listIndexes(prisma);
      const notTenantLeading = indexes.filter((i) => !i.primary && i.columns[0] !== "tenant_id").map((i) => i.name);
      // Global by design: Permission is a global catalog, refresh_token_hash is globally unique, permission_id is a
      // simple FK to the global catalog. Primary keys are on id.
      expect(notTenantLeading).toEqual([
        "permissions_code_key",
        "permissions_module_idx",
        "role_permissions_permission_id_idx",
        "sessions_refresh_token_hash_key",
      ]);
    });
  });

  describe("FK coverage by child-side indexes", () => {
    it("covers every FK by the leftmost prefix of a B-tree index of the child table, with no exception", async () => {
      expect(FK_COVERAGE_EXCEPTIONS).toEqual({});
      expect(await foreignKeyCoverageViolations(prisma)).toEqual([]);
    });

    it("probe: an FK without a covering index is reported (a partial index does not count)", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`ALTER TABLE "${PROBE}" ADD CONSTRAINT "${PROBE}_role_fkey" FOREIGN KEY ("tenant_id", "role_id")
          REFERENCES roles ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await tx.$executeRawUnsafe(`CREATE INDEX "${PROBE}_partial_idx" ON "${PROBE}" ("tenant_id", "role_id") WHERE "role_id" IS NOT NULL`);
        // A prefix in another order does not count either.
        await tx.$executeRawUnsafe(`CREATE INDEX "${PROBE}_reversed_idx" ON "${PROBE}" ("role_id", "tenant_id")`);
        return foreignKeyCoverageViolations(tx);
      });
      expect(violations).toEqual([`${PROBE}_role_fkey: no B-tree index on ${PROBE} starting with (tenant_id, role_id)`]);
    });

    it("probe: a wider index whose prefix matches covers the FK", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`ALTER TABLE "${PROBE}" ADD CONSTRAINT "${PROBE}_role_fkey" FOREIGN KEY ("tenant_id", "role_id")
          REFERENCES roles ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await tx.$executeRawUnsafe(`CREATE INDEX "${PROBE}_wide_idx" ON "${PROBE}" ("tenant_id", "role_id", "id")`);
        return foreignKeyCoverageViolations(tx);
      });
      expect(violations).toEqual([]);
    });
  });

  describe("redundant indexes", () => {
    it("keeps companies_tenant_id_idx removed and has no structurally redundant index", async () => {
      expect(KNOWN_REDUNDANT_INDEXES).toEqual(["companies_tenant_id_idx"]);
      expect((await listIndexes(prisma)).map((i) => i.name)).not.toContain("companies_tenant_id_idx");
      expect(await redundantIndexViolations(prisma)).toEqual([]);
    });

    it("probe: recreating companies_tenant_id_idx is reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`CREATE INDEX "companies_tenant_id_idx" ON "companies" ("tenant_id")`);
        return redundantIndexViolations(tx);
      });
      expect(violations).toEqual(["companies_tenant_id_idx: known redundant index was recreated"]);
    });

    it("probe: a plain index that is a leftmost prefix of another is reported; unique and partial ones are not", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE INDEX "${PROBE}_tenant_idx" ON "${PROBE}" ("tenant_id")`);
        await tx.$executeRawUnsafe(`CREATE INDEX "${PROBE}_tenant_role_idx" ON "${PROBE}" ("tenant_id", "role_id")`);
        await tx.$executeRawUnsafe(`CREATE UNIQUE INDEX "${PROBE}_tenant_key" ON "${PROBE}" ("tenant_id") WHERE "role_id" IS NULL`);
        return redundantIndexViolations(tx);
      });
      expect(violations).toEqual([`${PROBE}_tenant_idx: (tenant_id) is a leftmost prefix of ${PROBE}_tenant_role_idx`]);
    });
  });

  describe("auxiliary UNIQUE (tenant_id, id)", () => {
    it("exists on exactly the composite-FK targets, each referenced by its tenant-carrying FKs", async () => {
      const rows = await prisma.$queryRaw<{ index: string; fks: string[] }[]>`
        SELECT i.relname::text AS index, array_agg(con.conname::text ORDER BY con.conname) AS fks
        FROM pg_constraint con JOIN pg_class i ON i.oid = con.conindid
        WHERE con.contype = 'f' AND i.relname LIKE '%\\_tenant\\_id\\_id\\_key'
        GROUP BY i.relname ORDER BY 1`;
      expect(rows).toEqual([
        { index: "branches_tenant_id_id_key", fks: ["audit_logs_tenant_id_branch_id_fkey", "devices_tenant_id_branch_id_fkey", "user_branch_access_tenant_id_branch_id_fkey"] },
        { index: "companies_tenant_id_id_key", fks: ["branches_tenant_id_company_id_fkey"] },
        { index: "devices_tenant_id_id_key", fks: ["audit_logs_tenant_id_device_id_fkey", "sessions_tenant_id_device_id_fkey"] },
        { index: "roles_tenant_id_id_key", fks: ["role_permissions_tenant_id_role_id_fkey", "user_roles_tenant_id_role_id_fkey"] },
        {
          index: "users_tenant_id_id_key",
          fks: [
            "audit_logs_tenant_id_user_id_fkey",
            "sessions_tenant_id_user_id_fkey",
            "user_branch_access_tenant_id_user_id_fkey",
            "user_roles_tenant_id_user_id_fkey",
          ],
        },
      ]);
      expect(await compositeFkTargetViolations(prisma)).toEqual([]);
    });

    it("probe: a UNIQUE (tenant_id, id) that no FK uses is reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE UNIQUE INDEX "${PROBE}_tenant_id_id_key" ON "${PROBE}" ("tenant_id", "id")`);
        return compositeFkTargetViolations(tx);
      });
      expect(violations).toEqual([`${PROBE}_tenant_id_id_key: UNIQUE (tenant_id, id) not used by any composite FK`]);
    });
  });

  describe("manual partial indexes (UserRole scopes)", () => {
    it("pins both scope indexes: columns, order, uniqueness, B-tree and predicate", async () => {
      expect(Object.keys(MANUAL_PARTIAL_INDEXES)).toEqual(["user_roles_branch_scope_key", "user_roles_tenant_scope_key"]);
      expect(await partialIndexViolations(prisma)).toEqual([]);
    });

    it("probe: a changed predicate, a missing index and an unexpected partial index are reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX user_roles_tenant_scope_key`);
        // Narrower than the original predicate, so the rows other test files wrote can never violate it.
        await tx.$executeRawUnsafe(
          `CREATE UNIQUE INDEX user_roles_tenant_scope_key ON user_roles (tenant_id, user_id, role_id) WHERE branch_id IS NULL AND tenant_id IS NOT NULL`,
        );
        await tx.$executeRawUnsafe(`DROP INDEX user_roles_branch_scope_key`);
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`CREATE INDEX "${PROBE}_partial_idx" ON "${PROBE}" ("tenant_id") WHERE "role_id" IS NOT NULL`);
        return partialIndexViolations(tx);
      });
      expect(violations).toEqual([
        "user_roles_branch_scope_key: manual partial index is missing",
        "user_roles_tenant_scope_key: differs from the approved definition",
        `${PROBE}_partial_idx: unexpected partial index`,
      ]);
    });
  });

  describe("manual CHECK constraints", () => {
    it("pins every CHECK of the schema with its exact definition", async () => {
      expect(Object.keys(MANUAL_CHECK_CONSTRAINTS)).toHaveLength(21);
      expect(await checkConstraintViolations(prisma)).toEqual([]);
    });

    it("probe: a missing, a changed, a NOT VALID and an unexpected CHECK are reported", async () => {
      const violations = await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE permissions DROP CONSTRAINT permissions_module_check`);
        await tx.$executeRawUnsafe(`ALTER TABLE permissions DROP CONSTRAINT permissions_description_check`);
        await tx.$executeRawUnsafe(`ALTER TABLE permissions ADD CONSTRAINT permissions_description_check CHECK (description <> '')`);
        await tx.$executeRawUnsafe(`ALTER TABLE permissions DROP CONSTRAINT permissions_code_check`);
        await tx.$executeRawUnsafe(`ALTER TABLE permissions ADD CONSTRAINT permissions_code_check
          CHECK (code ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$') NOT VALID`);
        await tx.$executeRawUnsafe(createProbe);
        await tx.$executeRawUnsafe(`ALTER TABLE "${PROBE}" ADD CONSTRAINT "${PROBE}_check" CHECK (id IS NOT NULL)`);
        return checkConstraintViolations(tx);
      });
      expect(violations).toEqual([
        "permissions.permissions_code_check: differs from the approved definition", // NOT VALID
        "permissions.permissions_description_check: differs from the approved definition",
        "permissions.permissions_module_check: manual CHECK is missing",
        `${PROBE}.${PROBE}_check: unexpected CHECK`,
      ]);
    });
  });
});
