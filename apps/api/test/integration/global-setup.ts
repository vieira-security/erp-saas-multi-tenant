import type { TestProject } from "vitest/node";
import { createDisposableDatabase, dropDatabase, runPrisma, testServerUrl } from "./database.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// Each run gets a brand-new database, migrated from scratch, and drops it at the end.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const serverUrl = testServerUrl();
  const db = await createDisposableDatabase(serverUrl);
  try {
    const migrate = await runPrisma(["migrate", "deploy"], db.url);
    if (migrate.code !== 0) throw new Error(`prisma migrate deploy failed:\n${migrate.output}`);
  } catch (error) {
    await dropDatabase(serverUrl, db.name);
    throw error;
  }
  project.provide("databaseUrl", db.url);
  return () => dropDatabase(serverUrl, db.name);
}
