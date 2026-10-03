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

/**
 * Hashed credentials allowed to be stored, as "<table>.<column>". Anything else whose name looks like a
 * credential (password, token, secret, api/private key, pin...) is reported, including in other tables.
 */
export const HASHED_CREDENTIAL_COLUMNS: readonly string[] = ["sessions.refresh_token_hash", "users.password_hash"];

const CREDENTIAL_NAME = "(^|_)(password|passwd|pwd|senha|secret|pin|credentials?|token|api_?key|private_?key)(_|$)";

/** Text-like columns named like a credential and not in the hashed allowlist (flags are not credentials). */
export async function credentialColumnViolations(db: Queryable): Promise<string[]> {
  const rows = await db.$queryRaw<{ column: string }[]>`
    SELECT table_name || '.' || column_name AS "column" FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'character', 'bytea', 'json', 'jsonb')
      AND column_name ~* ${CREDENTIAL_NAME}
    ORDER BY 1`;
  return rows.map((r) => r.column).filter((c) => !HASHED_CREDENTIAL_COLUMNS.includes(c));
}

/** Shared function behind every `<table>_tenant_id_immutable` trigger. */
export const TENANT_ID_IMMUTABILITY_FUNCTION = "forbid_tenant_id_change";

type ProtectedEvent = "UPDATE" | "DELETE" | "TRUNCATE";

interface PolicyTrigger {
  name: string;
  level: "row" | "statement";
  events: readonly ProtectedEvent[];
}

export interface SpecialTenantIdPolicy {
  policy: "append-only";
  fn: string;
  triggers: readonly PolicyTrigger[];
}

/** Every operation an append-only table must block (INSERT stays allowed). */
export const APPEND_ONLY_BLOCKED_EVENTS: readonly ProtectedEvent[] = ["UPDATE", "DELETE", "TRUNCATE"];

/**
 * Tenant tables protected by a dedicated policy instead of the generic tenant_id trigger. Adding one here is an
 * explicit, reviewed decision; the policy itself is verified (it is not a silent exemption).
 * - append-only: UPDATE, DELETE and TRUNCATE are all rejected (BEFORE triggers), so tenant_id can never change
 *   either. Exactly the listed triggers may exist on the table; a partially protected table is a violation.
 */
export const SPECIAL_TENANT_ID_POLICIES: Readonly<Record<string, SpecialTenantIdPolicy>> = {
  audit_logs: {
    policy: "append-only",
    fn: "forbid_audit_log_mutation",
    triggers: [
      { name: "audit_logs_append_only", level: "row", events: ["UPDATE", "DELETE"] },
      { name: "audit_logs_no_truncate", level: "statement", events: ["TRUNCATE"] },
    ],
  },
};

interface TriggerRow {
  table: string;
  name: string;
  fn: string;
  enabled: string;
  row: boolean;
  before: boolean;
  onInsert: boolean;
  onUpdate: boolean;
  onDelete: boolean;
  onTruncate: boolean;
  columns: string[];
  definition: string;
}

async function listTriggers(db: Queryable): Promise<TriggerRow[]> {
  return db.$queryRaw<TriggerRow[]>`
    SELECT c.relname::text AS "table", t.tgname::text AS name, p.proname::text AS fn, t.tgenabled::text AS enabled,
           (t.tgtype & 1) <> 0 AS row, (t.tgtype & 2) <> 0 AS before, (t.tgtype & 4) <> 0 AS "onInsert",
           (t.tgtype & 16) <> 0 AS "onUpdate", (t.tgtype & 8) <> 0 AS "onDelete", (t.tgtype & 32) <> 0 AS "onTruncate",
           COALESCE((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                     WHERE a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr)), '{}') AS columns,
           pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname`;
}

/** Exact approved definition of the tenant_id immutability trigger of `table`. */
export function tenantIdTriggerDefinition(table: string): string {
  return (
    `CREATE TRIGGER ${table}_tenant_id_immutable BEFORE UPDATE OF tenant_id ON public.${table} FOR EACH ROW ` +
    `WHEN ((old.tenant_id IS DISTINCT FROM new.tenant_id)) EXECUTE FUNCTION ${TENANT_ID_IMMUTABILITY_FUNCTION}()`
  );
}

function triggerEvents(t: TriggerRow): ProtectedEvent[] {
  const events: ProtectedEvent[] = [];
  if (t.onUpdate) events.push("UPDATE");
  if (t.onDelete) events.push("DELETE");
  if (t.onTruncate) events.push("TRUNCATE");
  return events;
}

/** Verifies a special policy completely: required triggers exactly as declared, every blocked event, nothing else. */
function specialPolicyViolations(table: string, special: SpecialTenantIdPolicy, triggers: TriggerRow[]): string[] {
  const violations: string[] = [];
  const onTable = triggers.filter((t) => t.table === table);

  const declared = new Set(special.triggers.flatMap((t) => t.events));
  for (const event of APPEND_ONLY_BLOCKED_EVENTS) {
    if (!declared.has(event)) violations.push(`${table}: ${special.policy} policy must block ${event}`);
  }

  for (const required of special.triggers) {
    const t = onTable.find((x) => x.name === required.name);
    if (!t) {
      violations.push(`${table}: missing ${special.policy} trigger ${required.name}`);
      continue;
    }
    const ok =
      t.fn === special.fn &&
      t.enabled === "O" &&
      t.before &&
      t.row === (required.level === "row") &&
      !t.onInsert &&
      triggerEvents(t).join(",") === required.events.join(",") &&
      t.columns.length === 0;
    if (!ok) {
      violations.push(
        `${table}: ${required.name} must be an enabled BEFORE ${required.events.join(" OR ")} ${required.level} trigger calling ${special.fn}()`,
      );
    }
  }

  for (const t of onTable.filter((x) => !special.triggers.some((r) => r.name === x.name))) {
    violations.push(
      t.fn === TENANT_ID_IMMUTABILITY_FUNCTION
        ? `${table}: ${special.policy} table must not use the generic tenant_id trigger`
        : `${table}: unexpected trigger ${t.name} on ${special.policy} table`,
    );
  }
  return violations;
}

/**
 * tenant_id immutability violations, as "<table>: <problem>". Fail-closed: every tenant table (derived from the
 * classification, never from a manual list) needs exactly the approved trigger, unless it is declared in
 * SPECIAL_TENANT_ID_POLICIES, whose own policy is then verified. Non-tenant tables must not use the trigger.
 */
export async function tenantIdImmutabilityViolations(
  db: Queryable,
  policies: Readonly<Record<string, SpecialTenantIdPolicy>> = SPECIAL_TENANT_ID_POLICIES,
): Promise<string[]> {
  const triggers = await listTriggers(db);
  const violations: string[] = [];

  for (const table of await tenantScopedTables(db)) {
    const generic = triggers.filter((t) => t.table === table && t.fn === TENANT_ID_IMMUTABILITY_FUNCTION);
    const special = policies[table];

    if (special) {
      violations.push(...specialPolicyViolations(table, special, triggers));
      continue;
    }

    if (generic.length === 0) {
      violations.push(`${table}: missing tenant_id immutability trigger (${table}_tenant_id_immutable)`);
      continue;
    }
    if (generic.length > 1) violations.push(`${table}: more than one tenant_id immutability trigger`);
    for (const t of generic) {
      if (t.name !== `${table}_tenant_id_immutable`) violations.push(`${table}: trigger ${t.name} must be named ${table}_tenant_id_immutable`);
      if (!t.before) violations.push(`${table}: ${t.name} must be BEFORE`);
      if (!t.row) violations.push(`${table}: ${t.name} must be FOR EACH ROW`);
      if (!t.onUpdate || t.onInsert || t.onDelete || t.onTruncate) violations.push(`${table}: ${t.name} must fire on UPDATE only`);
      if (t.columns.join(",") !== "tenant_id") violations.push(`${table}: ${t.name} must be UPDATE OF tenant_id`);
      if (t.enabled !== "O") violations.push(`${table}: ${t.name} must be enabled`);
      if (t.definition !== tenantIdTriggerDefinition(table)) violations.push(`${table}: ${t.name} differs from the approved definition`);
    }
  }

  const tenantTables = new Set(await tenantScopedTables(db));
  for (const t of triggers.filter((t) => t.fn === TENANT_ID_IMMUTABILITY_FUNCTION && !tenantTables.has(t.table))) {
    violations.push(`${t.table}: non-tenant table must not use ${TENANT_ID_IMMUTABILITY_FUNCTION}()`);
  }
  for (const [table, special] of Object.entries(policies)) {
    for (const t of triggers.filter((t) => t.fn === special.fn && t.table !== table)) {
      violations.push(`${t.table}: ${special.fn}() is specific to ${table}`);
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
