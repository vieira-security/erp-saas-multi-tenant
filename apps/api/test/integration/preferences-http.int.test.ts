import type { MePreferencesDto } from "@erp/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { DEFAULT_PASSWORD, authHarness, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";
import { expectTenantIdImmutable } from "./tenant-immutability.js";

// KAN-42 over real HTTP (erp_app), plus the guarantees of the user_preferences table itself.
describe("KAN-42 user preferences (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config);
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  /** A user WITHOUT any role: preferences need authentication only. */
  async function login(org: Org, input: { mustChangePassword?: boolean } = {}) {
    const user = await seedUser(owner, org.tenantId, input);
    const tokens = await h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: DEFAULT_PASSWORD });
    const token = tokens.accessToken;
    return {
      userId: user.id,
      get: () => http.request("/me/preferences", { token }),
      put: (body: unknown) => http.request("/me/preferences", { method: "PUT", token, body }),
    };
  }

  it("returns the default GRID for a user who never saved, without creating a row", async () => {
    const org = await seedOrg(owner, "Prefs Default");
    const me = await login(org);
    expect(await me.get()).toEqual({ status: 200, body: { catalogView: "GRID" } satisfies MePreferencesDto });
    expect(await owner.userPreference.count({ where: { userId: me.userId } })).toBe(0);
  });

  it("PUT LIST then GET -> LIST; repeating the same value is a no-op; switching back works", async () => {
    const org = await seedOrg(owner, "Prefs Put");
    const me = await login(org);
    expect(await me.put({ catalogView: "LIST" })).toEqual({ status: 200, body: { catalogView: "LIST" } });
    expect(await me.get()).toEqual({ status: 200, body: { catalogView: "LIST" } });
    const first = await owner.userPreference.findFirstOrThrow({ where: { userId: me.userId } });
    expect(first).toMatchObject({ tenantId: org.tenantId, catalogView: "LIST" });
    expect(await me.put({ catalogView: "LIST" })).toEqual({ status: 200, body: { catalogView: "LIST" } });
    expect(await owner.userPreference.findFirstOrThrow({ where: { userId: me.userId } })).toEqual(first);
    expect(await me.put({ catalogView: "GRID" })).toEqual({ status: 200, body: { catalogView: "GRID" } });
    expect(await owner.userPreference.count({ where: { userId: me.userId } })).toBe(1);
  });

  it("isolates users and tenants: each one only ever reads and writes its own row", async () => {
    const a = await seedOrg(owner, "Prefs A");
    const b = await seedOrg(owner, "Prefs B");
    const [a1, a2, b1] = [await login(a), await login(a), await login(b)];
    await a1.put({ catalogView: "LIST" });
    expect(await a2.get()).toEqual({ status: 200, body: { catalogView: "GRID" } });
    expect(await b1.get()).toEqual({ status: 200, body: { catalogView: "GRID" } });
    await b1.put({ catalogView: "LIST" });
    await a2.put({ catalogView: "GRID" });
    const rows = await owner.userPreference.findMany({ where: { userId: { in: [a1.userId, a2.userId, b1.userId] } }, orderBy: { userId: "asc" } });
    expect(rows.map((r) => [r.userId, r.tenantId, r.catalogView]).sort()).toEqual(
      [
        [a1.userId, a.tenantId, "LIST"],
        [a2.userId, a.tenantId, "GRID"],
        [b1.userId, b.tenantId, "LIST"],
      ].sort(),
    );
  });

  it("400 for invalid value, unknown field (userId/tenantId never come from the body) and empty body", async () => {
    const org = await seedOrg(owner, "Prefs Bad");
    const me = await login(org);
    const bad = (details: unknown) => ({ status: 400, body: { error: "validation_failed", details } });
    expect(await me.put({ catalogView: "TABLE" })).toEqual(bad([{ field: "catalogView", issue: "invalid_value" }]));
    expect(await me.put({ catalogView: "LIST", userId: me.userId })).toEqual(bad([{ field: "userId", issue: "unknown_field" }]));
    expect(await me.put({ catalogView: "LIST", tenantId: org.tenantId })).toEqual(bad([{ field: "tenantId", issue: "unknown_field" }]));
    expect(await me.put({})).toEqual(bad([{ field: "catalogView", issue: "required" }]));
    expect(await owner.userPreference.count({ where: { userId: me.userId } })).toBe(0);
  });

  it("requires authentication and follows the password-change guard", async () => {
    expect((await http.request("/me/preferences")).status).toBe(401);
    const org = await seedOrg(owner, "Prefs Must Change");
    const me = await login(org, { mustChangePassword: true });
    expect(await me.get()).toEqual({ status: 403, body: { error: "password_change_required" } });
    expect(await me.put({ catalogView: "LIST" })).toEqual({ status: 403, body: { error: "password_change_required" } });
  });

  describe("user_preferences table", () => {
    it("rejects a value outside the CHECK, a user of another tenant (composite FK) and a second row per user", async () => {
      const a = await seedOrg(owner, "Prefs Schema A");
      const b = await seedOrg(owner, "Prefs Schema B");
      const ua = await seedUser(owner, a.tenantId);
      const ub = await seedUser(owner, b.tenantId);
      await expect(prisma.userPreference.create({ data: { tenantId: a.tenantId, userId: ua.id, catalogView: "TABLE" } })).rejects.toThrow(/user_preferences_catalog_view_check/);
      await expect(prisma.userPreference.create({ data: { tenantId: a.tenantId, userId: ub.id, catalogView: "LIST" } })).rejects.toThrow(/user_preferences_tenant_id_user_id_fkey/);
      await prisma.userPreference.create({ data: { tenantId: a.tenantId, userId: ua.id, catalogView: "LIST" } });
      await expect(prisma.userPreference.create({ data: { tenantId: a.tenantId, userId: ua.id, catalogView: "GRID" } })).rejects.toThrow();
    });

    it("keeps tenant_id immutable and gives erp_app no DELETE/TRUNCATE", async () => {
      const a = await seedOrg(owner, "Prefs Imm A");
      const b = await seedOrg(owner, "Prefs Imm B");
      const ua = await seedUser(owner, a.tenantId);
      const row = await owner.userPreference.create({ data: { tenantId: a.tenantId, userId: ua.id, catalogView: "LIST" } });
      await expectTenantIdImmutable(owner.$executeRaw`UPDATE user_preferences SET tenant_id = ${b.tenantId}::uuid WHERE id = ${row.id}::uuid`, "user_preferences");
      await expect(prisma.$executeRaw`DELETE FROM user_preferences WHERE id = ${row.id}::uuid`).rejects.toThrow(/permission denied/);
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "user_preferences"`)).rejects.toThrow(/permission denied/);
    });
  });
});
