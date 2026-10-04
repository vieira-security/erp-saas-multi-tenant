import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";

const apiRoot = fileURLToPath(new URL("../..", import.meta.url));
const prismaCli = join(dirname(createRequire(import.meta.url).resolve("prisma/package.json")), "build/index.js");

/**
 * Server URL used only to create/drop disposable databases. Must point to a PostgreSQL
 * dedicated to tests; DATABASE_URL (dev/prod) is never read here.
 */
export function testServerUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it to a PostgreSQL server dedicated to tests " +
        "(e.g. postgresql://postgres:postgres@127.0.0.1:5432/postgres). See docs/testing-strategy.md.",
    );
  }
  return url;
}

/**
 * Creates an empty database with a unique name and returns its URL. Its default time zone is
 * deliberately non-UTC so tests catch any connection that does not pin the session to UTC.
 */
export async function createDisposableDatabase(serverUrl: string): Promise<{ name: string; url: string }> {
  const name = `erp_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const admin = createPrismaClient(serverUrl);
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await admin.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO 'America/Sao_Paulo'`);
  } finally {
    await admin.$disconnect();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  if (!name.startsWith("erp_test_")) throw new Error(`refusing to drop non-test database ${name}`);
  const admin = createPrismaClient(serverUrl);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

/** Runs the Prisma CLI of this workspace against the given database. */
export async function runPrisma(args: string[], databaseUrl: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, ...args], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

const infrastructureDir = fileURLToPath(new URL("../../../../infrastructure/postgres/", import.meta.url));

/** Per-run names of the two application roles (roles are cluster-wide, so concurrent runs must not collide). */
export interface TestRoles {
  migrator: string;
  app: string;
}

export function testRoles(): TestRoles {
  const suffix = randomBytes(4).toString("hex");
  return { migrator: `erp_migrator_t${suffix}`, app: `erp_app_t${suffix}` };
}

/** `serverUrl` pointed at `database`, optionally logging in as `user` with `password`. */
export function databaseUrl(serverUrl: string, database: string, login?: { user: string; password: string }): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  if (login) {
    url.username = encodeURIComponent(login.user);
    url.password = encodeURIComponent(login.password);
  }
  return url.toString();
}

/** Splits a SQL script into statements, keeping `$$ ... $$` bodies and quoted literals intact. */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollar = false;
  let inQuote = false;
  for (const line of script.split("\n")) {
    if (!inDollar && !inQuote && line.trimStart().startsWith("--")) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (!inQuote && line.startsWith("$$", i)) {
        inDollar = !inDollar;
        current += "$$";
        i++;
        continue;
      }
      if (!inDollar && ch === "'") inQuote = !inQuote;
      if (!inDollar && !inQuote && ch === ";") {
        if (current.trim()) statements.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    current += "\n";
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Runs one of infrastructure/postgres/*.sql against `url` in a single transaction (like `psql --single-transaction`),
 * with the role names of this run in place of erp_migrator/erp_app. Same file, same policy as production.
 */
export async function runInfrastructureScript(url: string, file: string, roles: TestRoles): Promise<void> {
  const script = readFileSync(join(infrastructureDir, file), "utf8")
    .replace(/\berp_migrator\b/g, roles.migrator)
    .replace(/\berp_app\b/g, roles.app);
  const client = createPrismaClient(url);
  try {
    await client.$transaction(async (tx) => {
      for (const statement of splitSqlStatements(script)) await tx.$executeRawUnsafe(statement);
    });
  } finally {
    await client.$disconnect();
  }
}

/** Gives a role a random password, generated in memory for this run only (never stored). */
export async function setEphemeralPassword(adminUrl: string, role: string): Promise<string> {
  const password = randomBytes(24).toString("base64url");
  const client = createPrismaClient(adminUrl);
  try {
    // ALTER ROLE takes no bind parameters; base64url has no quote, so the literal is safe.
    await client.$executeRawUnsafe(`ALTER ROLE "${role}" PASSWORD '${password}'`);
  } finally {
    await client.$disconnect();
  }
  return password;
}

export async function dropRoles(serverUrl: string, roles: TestRoles): Promise<void> {
  const admin = createPrismaClient(serverUrl);
  try {
    for (const role of [roles.app, roles.migrator]) {
      if (!/^erp_(migrator|app)_t[0-9a-f]{8}$/.test(role)) throw new Error(`refusing to drop non-test role ${role}`);
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  } finally {
    await admin.$disconnect();
  }
}
