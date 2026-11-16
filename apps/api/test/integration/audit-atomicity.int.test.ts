import type { ProductDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { TenantProvisioningService } from "../../src/tenants/tenant-provisioning.service.js";
import { DEFAULT_PASSWORD, authHarness, ensurePermissionCatalog, seedOrg, seedUser, testAuthConfig } from "./auth-fixtures.js";
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
  type TestRoles,
} from "./database.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

/**
 * KAN-41: the business event is written IN THE SAME TRANSACTION as the action. Proven with faults injected by the owner
 * identity (temporary triggers). This needs its own disposable database: the shared one is inspected by the catalog
 * audits of other files running in parallel, which must never see these probe triggers.
 * - the audit insert fails -> the action fails and its change is rolled back;
 * - the action fails at COMMIT, after the audit insert -> the event disappears with it.
 */
describe("KAN-41 audit atomicity (own PostgreSQL database, as erp_app)", () => {
  let roles: TestRoles;
  let dbName: string;
  let owner: PrismaClient;
  let app: PrismaClient;
  let http: HttpApp;
  let token: string;
  let tenantId: string;
  let product: ProductDto;

  beforeAll(async () => {
    const serverUrl = testServerUrl();
    roles = testRoles();
    dbName = (await createDisposableDatabase(serverUrl)).name;
    const adminUrl = databaseUrl(serverUrl, dbName);
    await runInfrastructureScript(adminUrl, "01-bootstrap-roles.sql", roles);
    await runInfrastructureScript(adminUrl, "02-bootstrap-database.sql", roles);
    const migratorUrl = databaseUrl(serverUrl, dbName, { user: roles.migrator, password: await setEphemeralPassword(adminUrl, roles.migrator) });
    const appUrl = databaseUrl(serverUrl, dbName, { user: roles.app, password: await setEphemeralPassword(adminUrl, roles.app) });
    const migrate = await runPrisma(["migrate", "deploy"], migratorUrl);
    if (migrate.code !== 0) throw new Error(`migrate deploy failed:\n${migrate.output}`);
    await runInfrastructureScript(migratorUrl, "03-runtime-grants.sql", roles);

    owner = createPrismaClient(migratorUrl);
    app = createPrismaClient(appUrl);
    await ensurePermissionCatalog(owner);
    const config = testAuthConfig();
    const h = authHarness(app, config);
    http = await startHttpApp(app, config);
    const org = await seedOrg(owner, "Atomic");
    tenantId = org.tenantId;
    await h.tenants.run({ tenantId }, () => new TenantProvisioningService(app, h.scope).provisionDefaultRoles());
    const user = await seedUser(owner, tenantId);
    const { id: roleId } = await owner.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code: "OWNER" } } });
    await owner.userRole.create({ data: { tenantId, userId: user.id, roleId } });
    token = (await h.auth.login({ tenantId }, { employeeNumber: user.employeeNumber, password: DEFAULT_PASSWORD })).accessToken;
    const created = await http.request("/products", { method: "POST", token, body: { name: "X-Burger", basePrice: "25.00" } });
    expect(created.status).toBe(201);
    product = created.body as ProductDto;
  });

  afterAll(async () => {
    await http?.close();
    await app?.$disconnect();
    await owner?.$disconnect();
    const serverUrl = testServerUrl();
    if (dbName) await dropDatabase(serverUrl, dbName);
    if (roles) await dropRoles(serverUrl, roles);
  });

  const patchPrice = (basePrice: string) => http.request(`/products/${product.id}`, { method: "PATCH", token, body: { basePrice } });
  const price = async () => (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).basePrice.toFixed(2);
  const updates = () => owner.auditLog.count({ where: { tenantId, action: "product.updated" } });

  it("audit insert fails -> the action fails and nothing changes", async () => {
    await owner.$executeRawUnsafe(`
      CREATE FUNCTION probe_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'probe: audit insert refused'; END; $$`);
    await owner.$executeRawUnsafe(`
      CREATE TRIGGER probe_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW
      WHEN (NEW.action = 'product.updated') EXECUTE FUNCTION probe_fail_audit()`);
    try {
      expect((await patchPrice("27.00")).status).toBe(500);
      expect(await price()).toBe("25.00");
      expect(await updates()).toBe(0);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER probe_fail_audit ON audit_logs`);
      await owner.$executeRawUnsafe(`DROP FUNCTION probe_fail_audit()`);
    }
  });

  it("action fails at commit, after the audit insert -> the event is rolled back with it", async () => {
    await owner.$executeRawUnsafe(`
      CREATE FUNCTION probe_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'probe: commit refused'; END; $$`);
    await owner.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER probe_fail_commit AFTER UPDATE ON products
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_fail_commit()`);
    try {
      expect((await patchPrice("28.00")).status).toBe(500);
      expect(await price()).toBe("25.00");
      expect(await updates()).toBe(0);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER probe_fail_commit ON products`);
      await owner.$executeRawUnsafe(`DROP FUNCTION probe_fail_commit()`);
    }
  });

  it("without faults the same change commits with exactly one event", async () => {
    expect((await patchPrice("27.00")).status).toBe(200);
    expect(await price()).toBe("27.00");
    const events = await owner.auditLog.findMany({ where: { tenantId, action: "product.updated" } });
    expect(events.map((e) => e.metadata)).toEqual([{ changes: { basePrice: { from: "25.00", to: "27.00" } } }]);
  });
});
