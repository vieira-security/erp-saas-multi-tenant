import type { TestProject } from "vitest/node";
import {
  createDisposableDatabase,
  databaseUrl,
  dropDatabase,
  dropRoles,
  runInfrastructureScript,
  runPrisma,
  setEphemeralPassword,
  testRoles,
  testServerUrl,
} from "./database.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** erp_migrator of this run: owner of every object; used by schema/constraint tests. */
    databaseUrl: string;
    /** erp_app of this run: the runtime identity, with only the grants of 03-runtime-grants.sql. */
    appDatabaseUrl: string;
    /** Admin connection to the test database: only for probes that need another owner (never the app's path). */
    adminDatabaseUrl: string;
    migratorRole: string;
    appRole: string;
  }
}

// Each run gets brand-new roles and database, provisioned exactly like production (docs/database.md):
// 1. admin: infrastructure/postgres/01 + 02; 2. migrate deploy as erp_migrator; 3. 03 as erp_migrator; 4. app = erp_app.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const serverUrl = testServerUrl();
  const roles = testRoles();
  const db = await createDisposableDatabase(serverUrl);
  const adminUrl = databaseUrl(serverUrl, db.name);
  const cleanup = async () => {
    await dropDatabase(serverUrl, db.name);
    await dropRoles(serverUrl, roles);
  };

  try {
    await runInfrastructureScript(adminUrl, "01-bootstrap-roles.sql", roles);
    await runInfrastructureScript(adminUrl, "02-bootstrap-database.sql", roles);
    const migratorUrl = databaseUrl(serverUrl, db.name, { user: roles.migrator, password: await setEphemeralPassword(adminUrl, roles.migrator) });
    const appUrl = databaseUrl(serverUrl, db.name, { user: roles.app, password: await setEphemeralPassword(adminUrl, roles.app) });

    const migrate = await runPrisma(["migrate", "deploy"], migratorUrl);
    if (migrate.code !== 0) throw new Error(`prisma migrate deploy failed:\n${migrate.output}`);
    await runInfrastructureScript(migratorUrl, "03-runtime-grants.sql", roles);

    project.provide("databaseUrl", migratorUrl);
    project.provide("appDatabaseUrl", appUrl);
    project.provide("adminDatabaseUrl", adminUrl);
    project.provide("migratorRole", roles.migrator);
    project.provide("appRole", roles.app);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}
