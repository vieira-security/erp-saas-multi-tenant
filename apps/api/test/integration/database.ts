import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
