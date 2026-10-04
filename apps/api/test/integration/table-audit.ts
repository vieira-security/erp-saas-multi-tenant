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

/** PostgreSQL privileges of a table (all of them: the audit compares the full set, never a subset). */
export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "REFERENCES" | "TRIGGER";
export const TABLE_PRIVILEGES: readonly TablePrivilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/**
 * Exact runtime privileges of erp_app per table (mirror of infrastructure/postgres/03-runtime-grants.sql).
 * Fail-closed: every table in public needs an entry (an empty list means "no runtime access"); a table without an
 * entry, an extra privilege or a missing one is a violation. Never inferred by convention.
 */
export const RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, readonly TablePrivilege[]>> = {
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
};

export interface DatabaseRoles {
  migrator: string;
  app: string;
}

/**
 * Effective privileges of `appRole` (table-level OR any column-level grant, PUBLIC and memberships included) compared
 * with the declared policy, as "<table>: <problem>".
 */
export async function runtimePrivilegeViolations(
  db: Queryable,
  appRole: string,
  policy: Readonly<Record<string, readonly TablePrivilege[]>> = RUNTIME_TABLE_PRIVILEGES,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ table: string; privilege: TablePrivilege; granted: boolean }[]>`
    SELECT t.table_name::text AS "table", p.privilege,
           has_table_privilege(${appRole}, format('public.%I', t.table_name), p.privilege)
             OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                 AND has_any_column_privilege(${appRole}, format('public.%I', t.table_name), p.privilege)) AS granted
    FROM information_schema.tables t
    CROSS JOIN unnest(${[...TABLE_PRIVILEGES]}::text[]) WITH ORDINALITY AS p(privilege, position)
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY 1, p.position`;

  const violations: string[] = [];
  const tables = [...new Set(rows.map((r) => r.table))];
  for (const table of tables) {
    const expected = policy[table];
    if (!expected) {
      violations.push(`${table}: no runtime privilege policy declared`);
      continue;
    }
    for (const row of rows.filter((r) => r.table === table)) {
      const allowed = expected.includes(row.privilege);
      if (row.granted && !allowed) violations.push(`${table}: runtime role has ${row.privilege}, not allowed by the policy`);
      if (!row.granted && allowed) violations.push(`${table}: runtime role lacks ${row.privilege} required by the policy`);
    }
  }
  for (const table of Object.keys(policy).filter((t) => !tables.includes(t))) {
    violations.push(`${table}: runtime policy declared for a table that does not exist`);
  }

  const sequences = await db.$queryRaw<{ name: string }[]>`
    SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND (has_sequence_privilege(${appRole}, c.oid, 'USAGE') OR has_sequence_privilege(${appRole}, c.oid, 'SELECT')
           OR has_sequence_privilege(${appRole}, c.oid, 'UPDATE'))`;
  for (const s of sequences) violations.push(`${s.name}: runtime role has privileges on a sequence without a declared policy`);
  return violations;
}

/**
 * Ownership: every application object belongs to the migrator; the runtime role owns nothing in the database.
 * Indexes, TOAST tables, row types and array types always follow their table/type and are not listed separately.
 */
export async function ownershipViolations(db: Queryable, roles: DatabaseRoles): Promise<string[]> {
  const rows = await db.$queryRaw<{ kind: string; name: string; owner: string }[]>`
    SELECT 'relation' AS kind, c.relname::text AS name, pg_get_userbyid(c.relowner)::text AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT 'function', p.proname::text, pg_get_userbyid(p.proowner)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'type', t.typname::text, pg_get_userbyid(t.typowner)::text
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r', 'm')
    ORDER BY 1, 2`;
  const violations = rows
    .filter((r) => r.owner !== roles.migrator)
    .map((r) => `${r.kind} ${r.name}: owned by ${r.owner}, expected ${roles.migrator}`);

  const appOwned = await db.$queryRaw<{ object: string }[]>`
    SELECT 'relation ' || c.oid::regclass::text AS object FROM pg_class c
    WHERE c.relowner = ${roles.app}::regrole AND c.relkind NOT IN ('i', 'I', 't')
    UNION ALL SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.proowner = ${roles.app}::regrole
    UNION ALL SELECT 'type ' || t.oid::regtype::text FROM pg_type t
    WHERE t.typowner = ${roles.app}::regrole AND t.typrelid = 0 AND t.typcategory <> 'A'
    UNION ALL SELECT 'schema ' || n.nspname::text FROM pg_namespace n WHERE n.nspowner = ${roles.app}::regrole
    UNION ALL SELECT 'database ' || d.datname::text FROM pg_database d WHERE d.datdba = ${roles.app}::regrole
    ORDER BY 1`;
  violations.push(...appOwned.map((o) => `${o.object}: owned by the runtime role`));
  return violations;
}

/** Role attributes and memberships of both identities, plus schema, database and function privileges. */
export async function privilegeModelViolations(db: Queryable, roles: DatabaseRoles): Promise<string[]> {
  const violations: string[] = [];

  const attributes = await db.$queryRaw<{ role: string; login: boolean; elevated: boolean; memberOf: number }[]>`
    SELECT r.rolname::text AS role, r.rolcanlogin AS login,
           (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS elevated,
           (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS "memberOf"
    FROM pg_roles r WHERE r.rolname IN (${roles.migrator}, ${roles.app}) ORDER BY 1`;
  for (const role of [roles.migrator, roles.app]) {
    const a = attributes.find((x) => x.role === role);
    if (!a) violations.push(`${role}: role does not exist`);
    else {
      if (!a.login) violations.push(`${role}: must be LOGIN`);
      if (a.elevated) violations.push(`${role}: must be NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      if (a.memberOf > 0) violations.push(`${role}: must not be a member of any role`);
    }
  }

  const [access] = await db.$queryRaw<
    {
      appReachesMigrator: boolean;
      appSchemaCreate: boolean;
      appSchemaUsage: boolean;
      publicSchemaCreate: boolean;
      migratorSchemaCreate: boolean;
      appDatabaseCreate: boolean;
    }[]
  >`
    SELECT pg_has_role(${roles.app}, ${roles.migrator}, 'MEMBER') OR pg_has_role(${roles.app}, ${roles.migrator}, 'USAGE')
             OR pg_has_role(${roles.app}, ${roles.migrator}, 'SET') AS "appReachesMigrator",
           has_schema_privilege(${roles.app}, 'public', 'CREATE') AS "appSchemaCreate",
           has_schema_privilege(${roles.app}, 'public', 'USAGE') AS "appSchemaUsage",
           EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
                   WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS "publicSchemaCreate",
           has_schema_privilege(${roles.migrator}, 'public', 'CREATE') AS "migratorSchemaCreate",
           has_database_privilege(${roles.app}, current_database(), 'CREATE') AS "appDatabaseCreate"`;
  if (access?.appReachesMigrator) violations.push(`${roles.app}: must not be able to use or SET ROLE to ${roles.migrator}`);
  if (access?.appSchemaCreate) violations.push(`${roles.app}: must not have CREATE on schema public`);
  if (!access?.appSchemaUsage) violations.push(`${roles.app}: needs USAGE on schema public`);
  if (access?.publicSchemaCreate) violations.push("PUBLIC: must not have CREATE on schema public");
  if (!access?.migratorSchemaCreate) violations.push(`${roles.migrator}: needs CREATE on schema public`);
  if (access?.appDatabaseCreate) violations.push(`${roles.app}: must not have CREATE on the database`);

  // Functions: no implicit EXECUTE (a NULL acl means EXECUTE for PUBLIC) and none for the runtime role.
  const functions = await db.$queryRaw<{ name: string; publicExecute: boolean; appExecute: boolean }[]>`
    SELECT p.oid::regprocedure::text AS name,
           (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS "publicExecute",
           has_function_privilege(${roles.app}, p.oid, 'EXECUTE') AS "appExecute"
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`;
  for (const f of functions) {
    if (f.publicExecute) violations.push(`${f.name}: PUBLIC must not have EXECUTE`);
    if (f.appExecute) violations.push(`${f.name}: runtime role must not have EXECUTE`);
  }

  // Default privileges: future functions of the migrator get no EXECUTE for PUBLIC; nothing is granted by default
  // to the runtime role (tables, sequences, functions, types or schemas).
  const [defaults] = await db.$queryRaw<{ functionsLockedDown: boolean; appDefaults: number }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_default_acl d
                   WHERE d.defaclrole = ${roles.migrator}::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'
                     AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)) AS "functionsLockedDown",
           (SELECT count(*)::int FROM pg_default_acl d, aclexplode(d.defaclacl) a
            WHERE a.grantee = ${roles.app}::regrole) AS "appDefaults"`;
  if (!defaults?.functionsLockedDown) violations.push(`${roles.migrator}: default privileges must revoke EXECUTE on functions from PUBLIC`);
  if ((defaults?.appDefaults ?? 0) > 0) violations.push(`${roles.app}: must not receive default privileges`);
  return violations;
}

export interface IndexRow {
  table: string;
  name: string;
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  expression: boolean;
  predicate: string;
  /** Key columns in index order (INCLUDE columns and expressions left out). */
  columns: string[];
}

/** Every index of schema public, from the catalog (the source of truth: Prisma does not see partial indexes). */
export async function listIndexes(db: Queryable): Promise<IndexRow[]> {
  return db.$queryRaw<IndexRow[]>`
    SELECT t.relname::text AS "table", i.relname::text AS name, am.amname::text AS method, x.indisunique AS unique,
           x.indisprimary AS primary, x.indisvalid AS valid, x.indexprs IS NOT NULL AS expression,
           COALESCE(pg_get_expr(x.indpred, x.indrelid), '') AS predicate,
           ARRAY(SELECT a.attname::text FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(att, n)
                 JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.att
                 WHERE k.n <= x.indnkeyatts ORDER BY k.n) AS columns
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY 1, 2`;
}

/** A plain B-tree index usable for any equality lookup on its leading columns (not partial, no expression). */
function isPlainBtree(index: IndexRow): boolean {
  return index.method === "btree" && index.valid && !index.expression && index.predicate === "";
}

function startsWith(columns: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= columns.length && prefix.every((c, i) => columns[i] === c);
}

/**
 * FKs whose child columns are not covered, in the same order, by the leftmost prefix of a plain B-tree index of the
 * child table. Without it, every DELETE/UPDATE of a parent key (RESTRICT check) scans the whole child table.
 * Deliberate exceptions must be declared here with a reason; there are none.
 */
export const FK_COVERAGE_EXCEPTIONS: Readonly<Record<string, string>> = {};

export async function foreignKeyCoverageViolations(db: Queryable): Promise<string[]> {
  const fks = await db.$queryRaw<{ name: string; child: string; columns: string[] }[]>`
    SELECT con.conname::text AS name, cl.relname::text AS child,
           ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(att, n)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att ORDER BY k.n) AS columns
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND con.contype = 'f'
    ORDER BY 1`;
  const indexes = (await listIndexes(db)).filter(isPlainBtree);

  return fks
    .filter((fk) => !(fk.name in FK_COVERAGE_EXCEPTIONS))
    .filter((fk) => !indexes.some((i) => i.table === fk.child && startsWith(i.columns, fk.columns)))
    .map((fk) => `${fk.name}: no B-tree index on ${fk.child} starting with (${fk.columns.join(", ")})`);
}

/** Indexes removed as redundant; recreating one of them is a regression. */
export const KNOWN_REDUNDANT_INDEXES: readonly string[] = ["companies_tenant_id_idx"];

/**
 * Structural redundancy only (no workload heuristics): a plain non-unique B-tree index whose key columns are a
 * leftmost prefix of another plain B-tree index of the same table adds nothing for lookups. Unique and partial
 * indexes are never reported here (they carry a rule, not just access paths).
 */
export async function redundantIndexViolations(db: Queryable): Promise<string[]> {
  const indexes = await listIndexes(db);
  const violations = indexes
    .filter((i) => KNOWN_REDUNDANT_INDEXES.includes(i.name))
    .map((i) => `${i.name}: known redundant index was recreated`);

  const plain = indexes.filter(isPlainBtree);
  for (const index of plain.filter((i) => !i.unique && !KNOWN_REDUNDANT_INDEXES.includes(i.name))) {
    const wider = plain.find(
      (other) =>
        other.name !== index.name &&
        other.table === index.table &&
        startsWith(other.columns, index.columns) &&
        (other.columns.length > index.columns.length || other.unique || other.name < index.name),
    );
    if (wider) violations.push(`${index.name}: (${index.columns.join(", ")}) is a leftmost prefix of ${wider.name}`);
  }
  return violations;
}

/**
 * UNIQUE (tenant_id, id) looks redundant next to the primary key, but it is the target of the composite
 * tenant-carrying FKs. Each one must be referenced by at least one FK; an unreferenced one is reported (it would
 * then be truly redundant and should be dropped by a reviewed migration).
 */
export async function compositeFkTargetViolations(db: Queryable): Promise<string[]> {
  const rows = await db.$queryRaw<{ name: string; referencedBy: number }[]>`
    SELECT i.relname::text AS name,
           (SELECT count(*)::int FROM pg_constraint con WHERE con.contype = 'f' AND con.conindid = x.indexrelid) AS "referencedBy"
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND x.indisunique AND NOT x.indisprimary AND x.indnkeyatts = 2
      AND ARRAY(SELECT a.attname::text FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(att, n)
                JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.att ORDER BY k.n) = ARRAY['tenant_id', 'id']
    ORDER BY 1`;
  return rows.filter((r) => r.referencedBy === 0).map((r) => `${r.name}: UNIQUE (tenant_id, id) not used by any composite FK`);
}

/**
 * Partial indexes written by hand in migrations (Prisma 7.10 cannot represent them and `migrate diff` ignores them).
 * They carry business rules, so the exact set, columns, order, uniqueness, method and predicate are pinned.
 */
export const MANUAL_PARTIAL_INDEXES: Readonly<
  Record<string, { table: string; columns: readonly string[]; unique: boolean; method: string; predicate: string }>
> = {
  user_roles_branch_scope_key: {
    table: "user_roles",
    columns: ["tenant_id", "user_id", "role_id", "branch_id"],
    unique: true,
    method: "btree",
    predicate: "(branch_id IS NOT NULL)",
  },
  user_roles_tenant_scope_key: {
    table: "user_roles",
    columns: ["tenant_id", "user_id", "role_id"],
    unique: true,
    method: "btree",
    predicate: "(branch_id IS NULL)",
  },
};

export async function partialIndexViolations(db: Queryable): Promise<string[]> {
  const partial = (await listIndexes(db)).filter((i) => i.predicate !== "");
  const violations: string[] = [];
  for (const [name, expected] of Object.entries(MANUAL_PARTIAL_INDEXES)) {
    const actual = partial.find((i) => i.name === name);
    if (!actual) violations.push(`${name}: manual partial index is missing`);
    else {
      const { table, columns, unique, method, predicate } = actual;
      if (JSON.stringify({ table, columns, unique, method, predicate }) !== JSON.stringify(expected)) {
        violations.push(`${name}: differs from the approved definition`);
      }
    }
  }
  for (const i of partial.filter((p) => !(p.name in MANUAL_PARTIAL_INDEXES))) violations.push(`${i.name}: unexpected partial index`);
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
