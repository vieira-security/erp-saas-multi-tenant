import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import {
  RUNTIME_TABLE_PRIVILEGES,
  inRolledBackTransaction,
  listTables,
  ownershipViolations,
  privilegeModelViolations,
  runtimePrivilegeViolations,
  type DatabaseRoles,
} from "./table-audit.js";

// M1.14.2b: catalog audit of the PostgreSQL privilege model (infrastructure/postgres/*.sql). The functional side,
// executed for real as the runtime role, lives in app-role.int.test.ts.
describe("PostgreSQL privilege model (catalog audit)", () => {
  const roles: DatabaseRoles = { migrator: inject("migratorRole"), app: inject("appRole") };
  let owner: PrismaClient;
  let admin: PrismaClient;

  beforeAll(() => {
    owner = createPrismaClient(inject("databaseUrl"));
    admin = createPrismaClient(inject("adminDatabaseUrl"));
  });

  afterAll(async () => {
    await owner.$disconnect();
    await admin.$disconnect();
  });

  /** All three audits together, run inside `tx` so probes see their own uncommitted changes. */
  async function allViolations(tx: Parameters<typeof runtimePrivilegeViolations>[0]): Promise<string[]> {
    return [
      ...(await runtimePrivilegeViolations(tx, roles.app)),
      ...(await ownershipViolations(tx, roles)),
      ...(await privilegeModelViolations(tx, roles)),
    ];
  }

  describe("migrated and granted database", () => {
    it("reports no violation", async () => {
      expect(await allViolations(owner)).toEqual([]);
    });

    it("declares a runtime policy for exactly the tables that exist", async () => {
      expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual(await listTables(owner));
    });

    it("pins the exact runtime matrix", () => {
      expect(RUNTIME_TABLE_PRIVILEGES).toEqual({
        _prisma_migrations: [],
        audit_logs: ["SELECT", "INSERT"],
        branches: ["SELECT", "INSERT", "UPDATE"],
        companies: ["SELECT", "INSERT", "UPDATE"],
        devices: ["SELECT", "INSERT", "UPDATE"],
        permissions: ["SELECT"],
        role_permissions: ["SELECT", "INSERT", "DELETE"],
        roles: ["SELECT", "INSERT", "UPDATE"],
        sessions: ["SELECT", "INSERT", "UPDATE"],
        tenants: ["SELECT", "INSERT", "UPDATE"],
        user_branch_access: ["SELECT", "INSERT", "DELETE"],
        user_roles: ["SELECT", "INSERT", "DELETE"],
        users: ["SELECT", "INSERT", "UPDATE"],
      });
    });

    it("gives every table, enum and security function to the migrator, and nothing to the runtime role", async () => {
      const owners = await owner.$queryRaw<{ kind: string; owner: string; count: number }[]>`
        SELECT kind, owner, count(*)::int AS count FROM (
          SELECT 'table' AS kind, pg_get_userbyid(c.relowner)::text AS owner
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'
          UNION ALL
          SELECT 'enum', pg_get_userbyid(t.typowner)::text
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'
          UNION ALL
          SELECT 'function', pg_get_userbyid(p.proowner)::text
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
        ) o GROUP BY kind, owner ORDER BY kind`;
      expect(owners).toEqual([
        { kind: "enum", owner: roles.migrator, count: 7 },
        { kind: "function", owner: roles.migrator, count: 2 },
        { kind: "table", owner: roles.migrator, count: 13 },
      ]);
      // Triggers have no owner of their own: they belong to their table, hence to the migrator.
      const [schema] = await owner.$queryRaw<{ owner: string }[]>`
        SELECT pg_get_userbyid(nspowner)::text AS owner FROM pg_namespace WHERE nspname = 'public'`;
      expect(schema?.owner).not.toBe(roles.app);
    });

    it("creates both roles as LOGIN without elevated attributes or memberships", async () => {
      const rows = await owner.$queryRaw<Record<string, unknown>[]>`
        SELECT rolname::text AS role, rolcanlogin AS login, rolsuper AS super, rolcreatedb AS createdb,
               rolcreaterole AS createrole, rolreplication AS replication, rolbypassrls AS bypassrls,
               (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
        FROM pg_roles r WHERE rolname IN (${roles.migrator}, ${roles.app}) ORDER BY rolname`;
      const expected = { login: true, super: false, createdb: false, createrole: false, replication: false, bypassrls: false, memberships: 0 };
      expect(rows).toEqual([
        { role: roles.app, ...expected },
        { role: roles.migrator, ...expected },
      ]);
    });

    it("locks down security functions: no EXECUTE for PUBLIC or the runtime role, also for future functions", async () => {
      const rows = await owner.$queryRaw<{ name: string; acl: string | null; app: boolean }[]>`
        SELECT p.proname::text AS name, p.proacl::text AS acl, has_function_privilege(${roles.app}, p.oid, 'EXECUTE') AS app
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`;
      expect(rows).toEqual([
        { name: "forbid_audit_log_mutation", acl: `{${roles.migrator}=X/${roles.migrator}}`, app: false },
        { name: "forbid_tenant_id_change", acl: `{${roles.migrator}=X/${roles.migrator}}`, app: false },
      ]);
      const defaults = await owner.$queryRaw<{ objtype: string; acl: string }[]>`
        SELECT defaclobjtype::text AS objtype, defaclacl::text AS acl FROM pg_default_acl
        WHERE defaclrole = ${roles.migrator}::regrole ORDER BY 1`;
      expect(defaults).toEqual([{ objtype: "f", acl: `{${roles.migrator}=X/${roles.migrator}}` }]);
    });
  });

  describe("fail-closed probes (rolled back)", () => {
    it.each([
      ["UPDATE on audit_logs", `GRANT UPDATE ON audit_logs TO "$app"`, ["audit_logs: runtime role has UPDATE, not allowed by the policy"]],
      ["column-level UPDATE on audit_logs", `GRANT UPDATE (action) ON audit_logs TO "$app"`, ["audit_logs: runtime role has UPDATE, not allowed by the policy"]],
      ["DELETE on companies", `GRANT DELETE ON companies TO "$app"`, ["companies: runtime role has DELETE, not allowed by the policy"]],
      ["TRUNCATE on users", `GRANT TRUNCATE ON users TO "$app"`, ["users: runtime role has TRUNCATE, not allowed by the policy"]],
      ["any privilege to PUBLIC", `GRANT SELECT ON _prisma_migrations TO PUBLIC`, ["_prisma_migrations: runtime role has SELECT, not allowed by the policy"]],
      ["a missing SELECT on branches", `REVOKE SELECT ON branches FROM "$app"`, ["branches: runtime role lacks SELECT required by the policy"]],
      ["a missing INSERT on audit_logs", `REVOKE INSERT ON audit_logs FROM "$app"`, ["audit_logs: runtime role lacks INSERT required by the policy"]],
      [
        "a new table without policy",
        `CREATE TABLE audit_probe_runtime (id uuid PRIMARY KEY)`,
        ["audit_probe_runtime: no runtime privilege policy declared"],
      ],
      [
        "EXECUTE on a security function",
        `GRANT EXECUTE ON FUNCTION forbid_audit_log_mutation() TO "$app"`,
        ["forbid_audit_log_mutation(): runtime role must not have EXECUTE"],
      ],
      [
        "EXECUTE for PUBLIC on a security function",
        `GRANT EXECUTE ON FUNCTION forbid_tenant_id_change() TO PUBLIC`,
        ["forbid_tenant_id_change(): PUBLIC must not have EXECUTE", "forbid_tenant_id_change(): runtime role must not have EXECUTE"],
      ],
      [
        "default table privileges for the runtime role",
        `ALTER DEFAULT PRIVILEGES FOR ROLE "$migrator" GRANT SELECT ON TABLES TO "$app"`,
        ["$app: must not receive default privileges"],
      ],
      [
        "default EXECUTE for PUBLIC on future functions",
        `ALTER DEFAULT PRIVILEGES FOR ROLE "$migrator" GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,
        ["$migrator: default privileges must revoke EXECUTE on functions from PUBLIC"],
      ],
    ])("as migrator: reports %s", async (_, ddl, expected) => {
      const statement = ddl.replaceAll("$app", roles.app).replaceAll("$migrator", roles.migrator);
      const violations = await inRolledBackTransaction(owner, async (tx) => {
        await tx.$executeRawUnsafe(statement);
        return allViolations(tx);
      });
      expect(violations).toEqual(expected.map((v) => v.replaceAll("$app", roles.app).replaceAll("$migrator", roles.migrator)));
    });

    it.each([
      // An owner holds every privilege on its table, so the runtime matrix breaks as well.
      ["ownership of a table given to the runtime role", `ALTER TABLE companies OWNER TO "$app"`, [
        "companies: runtime role has DELETE, not allowed by the policy",
        "companies: runtime role has TRUNCATE, not allowed by the policy",
        "companies: runtime role has REFERENCES, not allowed by the policy",
        "companies: runtime role has TRIGGER, not allowed by the policy",
        "relation companies: owned by $app, expected $migrator",
        "relation companies: owned by the runtime role",
      ]],
      ["CREATE on schema public for the runtime role", `GRANT CREATE ON SCHEMA public TO "$app"`, ["$app: must not have CREATE on schema public"]],
      ["CREATE on schema public for PUBLIC", `GRANT CREATE ON SCHEMA public TO PUBLIC`, [
        "$app: must not have CREATE on schema public",
        "PUBLIC: must not have CREATE on schema public",
      ]],
      ["CREATE on the database", `GRANT CREATE ON DATABASE "$db" TO "$app"`, ["$app: must not have CREATE on the database"]],
      ["an elevated attribute", `ALTER ROLE "$app" CREATEDB`, ["$app: must be NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"]],
    ])("as admin: reports %s", async (_, ddl, expected) => {
      const [db] = await owner.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
      const fill = (text: string) => text.replaceAll("$app", roles.app).replaceAll("$migrator", roles.migrator).replaceAll("$db", db?.name ?? "");
      const violations = await inRolledBackTransaction(admin, async (tx) => {
        await tx.$executeRawUnsafe(fill(ddl));
        return allViolations(tx);
      });
      expect(violations).toEqual(expected.map(fill));
    });

    it("as admin: reports membership of the runtime role in the migrator (and every privilege it inherits)", async () => {
      const violations = await inRolledBackTransaction(admin, async (tx) => {
        await tx.$executeRawUnsafe(`GRANT "${roles.migrator}" TO "${roles.app}"`);
        return allViolations(tx);
      });
      expect(violations).toEqual(
        expect.arrayContaining([
          `${roles.app}: must not be a member of any role`,
          `${roles.app}: must not be able to use or SET ROLE to ${roles.migrator}`,
          "audit_logs: runtime role has UPDATE, not allowed by the policy",
          "audit_logs: runtime role has TRUNCATE, not allowed by the policy",
          "forbid_audit_log_mutation(): runtime role must not have EXECUTE",
        ]),
      );
    });

    it("rolls every probe back", async () => {
      expect(await allViolations(owner)).toEqual([]);
    });
  });
});
