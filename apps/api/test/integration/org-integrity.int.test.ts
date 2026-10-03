import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BranchStatus,
  CompanyStatus,
  TenantStatus,
  UserStatus,
  type Company,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";

// Tenant -> Company -> Branch, User and UserBranchAccess structural integrity (M1.4-M1.6).
// Per-entity behaviour (creation, uniqueness, CHECKs) lives in tenant/company/branch tests.

const ROOT_TABLE = "tenants";
const TOOLING_TABLES = ["_prisma_migrations"];
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
    async function tenantScopedTables(): Promise<string[]> {
      const rows = await prisma.$queryRaw<{ name: string }[]>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
      return rows.map((r) => r.name).filter((t) => t !== ROOT_TABLE && !TOOLING_TABLES.includes(t));
    }

    it("covers every tenant-scoped table (guards against an empty audit)", async () => {
      expect(await tenantScopedTables()).toEqual(["branches", "companies", "user_branch_access", "users"]);
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
      const scoped = new Set(await tenantScopedTables());

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
      expect(rows.map((r) => r.table)).toEqual(await tenantScopedTables());
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

    it("makes every FK between tenant-scoped tables carry tenant_id on both sides", async () => {
      const rows = await prisma.$queryRaw<{ name: string; carriesTenant: boolean }[]>`
        SELECT con.conname AS name,
               EXISTS (
                 SELECT 1 FROM unnest(con.conkey, con.confkey) AS k(child_att, parent_att)
                 JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_att
                 JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_att
                 WHERE ca.attname = 'tenant_id' AND pa.attname = 'tenant_id'
               ) AS "carriesTenant"
        FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE n.nspname = 'public' AND con.contype = 'f'
          AND con.confrelid <> 'public.tenants'::regclass
          AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        ORDER BY con.conname`;
      expect(rows).toEqual([
        { name: "branches_tenant_id_company_id_fkey", carriesTenant: true },
        { name: "user_branch_access_tenant_id_branch_id_fkey", carriesTenant: true },
        { name: "user_branch_access_tenant_id_user_id_fkey", carriesTenant: true },
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
