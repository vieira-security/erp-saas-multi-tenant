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
import {
  GLOBAL_TABLES,
  ROOT_TABLE,
  classifyTable,
  foreignKeyViolations,
  inRolledBackTransaction,
  listTables,
  tenantScopeViolations,
  tenantScopedTables,
} from "./table-audit.js";

// Multi-tenant structural integrity (M1.4-M1.9): tenant tables, explicit global tables, Prisma tooling.
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
        branches: "tenant",
        companies: "tenant",
        permissions: "global",
        role_permissions: "tenant",
        roles: "tenant",
        tenants: "root",
        user_branch_access: "tenant",
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
        "branches",
        "companies",
        "role_permissions",
        "roles",
        "user_branch_access",
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
          name: "users_tenant_id_fkey",
          definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        },
      ]);
    });

    it("stores no plain-text credential column (only users.password_hash)", async () => {
      // Only column types able to hold a secret; flags such as must_change_password are not credentials.
      const rows = await prisma.$queryRaw<{ column: string }[]>`
        SELECT table_name || '.' || column_name AS "column" FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'character', 'bytea', 'json', 'jsonb')
          AND column_name ~* '(^|_)(password|passwd|pwd|senha|secret|pin|credentials?)(_|$)'
        ORDER BY 1`;
      expect(rows.map((r) => r.column)).toEqual(["users.password_hash"]);
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
        ["branches_tenant_id_company_id_fkey", "tenant -> tenant"],
        ["role_permissions_permission_id_fkey", "tenant -> global"],
        ["role_permissions_tenant_id_role_id_fkey", "tenant -> tenant"],
        ["user_branch_access_tenant_id_branch_id_fkey", "tenant -> tenant"],
        ["user_branch_access_tenant_id_user_id_fkey", "tenant -> tenant"],
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

      await expect(prisma.branch.update({ where: { id: branch.id }, data: { tenantId: other.id } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.$executeRaw`UPDATE branches SET tenant_id = ${other.id}::uuid WHERE id = ${branch.id}::uuid`,
      ).rejects.toThrow(CROSS_TENANT_FK);
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

      await expect(prisma.company.update({ where: { id: company.id }, data: { tenantId: other.id } })).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE companies SET tenant_id = ${other.id}::uuid WHERE id = ${company.id}::uuid`,
      ).rejects.toThrow(CROSS_TENANT_FK);
    });

    it("blocks a company tenant_id change to a non-existent tenant", async () => {
      const company = await newCompany((await newTenant("A")).id);

      await expect(
        prisma.$executeRaw`UPDATE companies SET tenant_id = gen_random_uuid() WHERE id = ${company.id}::uuid`,
      ).rejects.toThrow(/companies_tenant_id_fkey/);
    });

    // Known gaps: tenant_id is conceptually immutable, but the schema alone cannot forbid a
    // *consistent* move. These tests pin today's behaviour so the M1.14 protection flips them.
    it("GAP (M1.14): accepts moving a branch when tenant_id and company_id change together", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const target = await newCompany((await newTenant("B")).id);
      const branch = await newBranch(company);

      const moved = await prisma.branch.update({
        where: { id: branch.id },
        data: { tenantId: target.tenantId, companyId: target.id },
      });

      expect(moved).toMatchObject({ tenantId: target.tenantId, companyId: target.id });
      expect(await crossTenantBranches()).toBe(0n); // consistent move: no cross-tenant relation is created
    });

    it("GAP (M1.14): accepts moving a company without branches to another tenant", async () => {
      const company = await newCompany((await newTenant("A")).id);
      const other = await newTenant("B");

      const moved = await prisma.company.update({ where: { id: company.id }, data: { tenantId: other.id } });

      expect(moved.tenantId).toBe(other.id);
    });
  });

  describe("tenant_id changes (User)", () => {
    async function newUser(name: string) {
      const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
      return prisma.user.create({
        data: { tenantId: tenant.id, name: "U", employeeNumber: "1001", passwordHash: "x", status: UserStatus.ACTIVE },
      });
    }

    it("blocks a user tenant_id change to a non-existent tenant", async () => {
      const user = await newUser("A");

      await expect(
        prisma.$executeRaw`UPDATE users SET tenant_id = gen_random_uuid() WHERE id = ${user.id}::uuid`,
      ).rejects.toThrow(/users_tenant_id_fkey/);
    });

    it("GAP (M1.14): accepts moving a user to another existing tenant", async () => {
      const user = await newUser("A");
      const other = await prisma.tenant.create({ data: { name: "B", status: TenantStatus.ACTIVE } });

      const moved = await prisma.user.update({ where: { id: user.id }, data: { tenantId: other.id } });

      expect(moved.tenantId).toBe(other.id);
    });
  });

  describe("tenant_id changes (Role)", () => {
    async function newRole(name: string) {
      const tenant = await prisma.tenant.create({ data: { name, status: TenantStatus.ACTIVE } });
      return prisma.role.create({ data: { tenantId: tenant.id, code: "OWNER", name: "Proprietário", status: RoleStatus.ACTIVE } });
    }

    it("blocks a role tenant_id change to a non-existent tenant", async () => {
      const role = await newRole("A");

      await expect(
        prisma.$executeRaw`UPDATE roles SET tenant_id = gen_random_uuid() WHERE id = ${role.id}::uuid`,
      ).rejects.toThrow(/roles_tenant_id_fkey/);
    });

    it("GAP (M1.14): accepts moving a role to another existing tenant", async () => {
      const role = await newRole("A");
      const other = await prisma.tenant.create({ data: { name: "B", status: TenantStatus.ACTIVE } });

      const moved = await prisma.role.update({ where: { id: role.id }, data: { tenantId: other.id } });

      expect(moved.tenantId).toBe(other.id);
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

      await expect(
        prisma.$executeRaw`UPDATE roles SET tenant_id = ${other.id}::uuid WHERE id = ${role.id}::uuid`,
      ).rejects.toThrow(/role_permissions_tenant_id_role_id_fkey/);
    });

    it("GAP (M1.14): accepts moving a role-permission when tenant_id and role_id change together", async () => {
      const roleA = await newRole("A");
      const roleB = await newRole("B");
      const link = await prisma.rolePermission.create({
        data: { tenantId: roleA.tenantId, roleId: roleA.id, permissionId: (await anyPermission()).id },
      });

      const moved = await prisma.rolePermission.update({
        where: { id: link.id },
        data: { tenantId: roleB.tenantId, roleId: roleB.id },
      });

      expect(moved).toMatchObject({ tenantId: roleB.tenantId, roleId: roleB.id });
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
