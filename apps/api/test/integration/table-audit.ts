import type { PrismaClient } from "../../src/generated/prisma/client.js";

// Every table in `public` must be classified. Anything not listed below is a tenant table and
// must carry `tenant_id uuid NOT NULL` with a direct FK to tenants (fail-closed).
export const ROOT_TABLE = "tenants";
export const TOOLING_TABLES: readonly string[] = ["_prisma_migrations"];
/** Legitimate global tables (no tenant_id). Adding one here is an explicit, reviewed decision. */
export const GLOBAL_TABLES: readonly string[] = ["permissions"];

export type TableKind = "root" | "tooling" | "global" | "tenant";

type Queryable = Pick<PrismaClient, "$queryRaw">;

export function classifyTable(name: string, globalTables: readonly string[] = GLOBAL_TABLES): TableKind {
  if (name === ROOT_TABLE) return "root";
  if (TOOLING_TABLES.includes(name)) return "tooling";
  if (globalTables.includes(name)) return "global";
  return "tenant";
}

export async function listTables(db: Queryable): Promise<string[]> {
  const rows = await db.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  return rows.map((r) => r.name);
}

export async function tenantScopedTables(db: Queryable): Promise<string[]> {
  return (await listTables(db)).filter((t) => classifyTable(t) === "tenant");
}

/** Tenant-scope violations, as "<table>: <problem>". Empty means the schema is compliant. */
export async function tenantScopeViolations(db: Queryable): Promise<string[]> {
  const rows = await db.$queryRaw<{ table: string; type: string | null; nullable: string | null; tenantFk: boolean }[]>`
    SELECT t.table_name AS "table", c.data_type AS type, c.is_nullable AS nullable,
           EXISTS (
             SELECT 1 FROM pg_constraint con
             WHERE con.contype = 'f' AND con.conrelid = format('public.%I', t.table_name)::regclass
               AND con.confrelid = 'public.tenants'::regclass
               AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)%'
           ) AS "tenantFk"
    FROM information_schema.tables t
    LEFT JOIN information_schema.columns c
      ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant_id'
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name`;

  const violations: string[] = [];
  for (const row of rows) {
    const kind = classifyTable(row.table);
    if (kind !== "tenant") {
      if (row.type !== null) violations.push(`${row.table}: ${kind} table must not have tenant_id`);
      continue;
    }
    if (row.type === null) violations.push(`${row.table}: missing tenant_id (declare it as global if intended)`);
    else if (row.type !== "uuid" || row.nullable !== "NO") violations.push(`${row.table}: tenant_id must be uuid NOT NULL`);
    if (!row.tenantFk) violations.push(`${row.table}: missing FK tenant_id -> tenants(id)`);
  }
  return violations;
}

/**
 * FK violations judged by the classification of both tables (never by their current columns):
 * - tenant -> root:   must be exactly (tenant_id) -> tenants(id);
 * - tenant -> tenant: must carry tenant_id on both sides (composite FK);
 * - tenant -> global: a simple FK is fine (global rows are shared by every tenant);
 * - global/root/tooling -> root or tenant: forbidden (shared data must not point at tenant data);
 * - anything -> tooling: forbidden.
 */
export async function foreignKeyViolations(
  db: Queryable,
  globalTables: readonly string[] = GLOBAL_TABLES,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ name: string; child: string; parent: string; definition: string; carriesTenant: boolean }[]>`
    SELECT con.conname AS name, cl.relname AS child, pr.relname AS parent,
           pg_get_constraintdef(con.oid) AS definition,
           EXISTS (
             SELECT 1 FROM unnest(con.conkey, con.confkey) AS k(child_att, parent_att)
             JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_att
             JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_att
             WHERE ca.attname = 'tenant_id' AND pa.attname = 'tenant_id'
           ) AS "carriesTenant"
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class pr ON pr.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND con.contype = 'f'
    ORDER BY con.conname`;

  const violations: string[] = [];
  for (const fk of rows) {
    const child = classifyTable(fk.child, globalTables);
    const parent = classifyTable(fk.parent, globalTables);
    if (parent === "tooling") {
      violations.push(`${fk.name}: must not reference Prisma tooling table ${fk.parent}`);
    } else if (child !== "tenant") {
      if (parent !== "global") violations.push(`${fk.name}: ${child} table must not reference ${parent} table ${fk.parent}`);
    } else if (parent === "root") {
      if (!fk.definition.startsWith("FOREIGN KEY (tenant_id) REFERENCES tenants(id)")) {
        violations.push(`${fk.name}: tenant table must reference tenants only via (tenant_id) -> tenants(id)`);
      }
    } else if (parent === "tenant" && !fk.carriesTenant) {
      violations.push(`${fk.name}: FK to tenant table ${fk.parent} must include tenant_id on both sides`);
    }
  }
  return violations;
}

const ROLLBACK = Symbol("rollback");

/** Runs `fn` inside a transaction that is always rolled back (DDL included). */
export async function inRolledBackTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Queryable & Pick<PrismaClient, "$executeRawUnsafe">) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result as T;
}
