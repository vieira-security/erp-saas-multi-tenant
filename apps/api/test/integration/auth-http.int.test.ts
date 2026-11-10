import { randomBytes } from "node:crypto";
import { Controller, Get } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TenantStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { AUTH_ENV } from "../../src/config/auth-config.js";
import { DEFAULT_PASSWORD, seedOrg, seedUser, testAuthConfig, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

const ORIGIN = "https://app.example.test";
const COOKIE = "__Secure-erp_rt";

@Controller("http-probe")
class HttpProbeController {
  @Get()
  ok(): unknown {
    return { ok: true };
  }
}

// M2 final: the real HTTP transport (login by public code, refresh cookie, logout), as erp_app.
describe("Auth over HTTP: login code, refresh cookie and logout (PostgreSQL, as erp_app)", () => {
  let owner: PrismaClient;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;

  beforeAll(async () => {
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig({ [AUTH_ENV.allowedOrigins]: ORIGIN });
    http = await startHttpApp(createPrismaClient(inject("appDatabaseUrl")), config, [HttpProbeController]);
    orgA = await seedOrg(owner, "HTTP A");
    orgB = await seedOrg(owner, "HTTP B");
  });

  afterAll(async () => {
    await http?.close();
    await owner.$disconnect();
  });

  const post = (path: string, init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    http.requestWithHeaders(path, {
      method: "POST",
      headers: { origin: ORIGIN, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });

  const login = (loginCode: string, employeeNumber: string, password = DEFAULT_PASSWORD, headers?: Record<string, string>) =>
    post("/auth/login", { body: { loginCode, employeeNumber, password }, ...(headers ? { headers } : {}) });

  /** Value of our refresh cookie in a Set-Cookie response (null if not set). */
  function setCookie(headers: Headers): { value: string; raw: string } | null {
    const raw = headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
    return raw ? { value: raw.slice(COOKIE.length + 1).split(";")[0]!, raw } : null;
  }

  const cookieHeader = (value: string) => `${COOKIE}=${value}`;
  const sessionOf = (refreshToken: string) => refreshToken.split(".")[2]!;
  const sessionRow = (id: string) => owner.session.findUniqueOrThrow({ where: { id } });

  async function loggedIn(org: Org = orgA) {
    const user = await seedUser(owner, org.tenantId);
    const res = await login(org.loginCode, user.employeeNumber);
    expect(res.status).toBe(200);
    return { user, res, accessToken: (res.body as { accessToken: string }).accessToken, refresh: setCookie(res.headers)!.value };
  }

  it("1/4. logs in with the public code (normalized) and sets only an HttpOnly, Secure, SameSite=Strict, /auth-scoped cookie", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const res = await login(`  ${orgA.loginCode.toLowerCase()} `, user.employeeNumber);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["accessToken", "accessTokenExpiresAt", "mustChangePassword", "sessionExpiresAt", "tokenType"]);
    expect(body["tokenType"]).toBe("Bearer");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cookie = setCookie(res.headers)!;
    expect(cookie.value).toMatch(/^rt1\./);
    expect(JSON.stringify(body)).not.toContain(cookie.value); // the refresh token never goes in the body
    const attrs = cookie.raw.split(";").map((a) => a.trim());
    expect(attrs).toEqual(expect.arrayContaining(["Path=/auth", "HttpOnly", "SameSite=Strict", "Secure"]));
    expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false);
    const maxAge = Number(attrs.find((a) => a.startsWith("Max-Age="))!.slice(8));
    expect(maxAge).toBeGreaterThan(12 * 3600 - 60);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);

    const accessToken = body["accessToken"] as string;
    expect((await http.request("/http-probe", { token: accessToken })).status).toBe(200);
  });

  it("2/3. unknown or malformed code and wrong credentials all get the same generic 401, and no cookie", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const responses = [
      await login("NOPE-0000", user.employeeNumber),
      await login("x", user.employeeNumber),
      await login(orgA.loginCode, user.employeeNumber, "Senha-Errada-1"),
      await login(orgA.loginCode, "NAO-EXISTE"),
    ];
    for (const res of responses) {
      expect({ status: res.status, body: res.body }).toEqual({ status: 401, body: { error: "invalid_credentials" } });
      expect(setCookie(res.headers)).toBeNull();
    }
    expect((await post("/auth/login", { body: { loginCode: orgA.loginCode } })).status).toBe(400);
  });

  it("5/6/7. refresh rotates the cookie; the old cookie is a replay that revokes the session and clears the cookie", async () => {
    const { refresh: first } = await loggedIn();
    const r1 = await post("/auth/refresh", { cookie: cookieHeader(first) });
    expect(r1.status).toBe(200);
    expect((r1.body as { accessToken: string }).accessToken).toBeTruthy();
    const second = setCookie(r1.headers)!.value;
    expect(second).not.toBe(first);
    expect(sessionOf(second)).toBe(sessionOf(first));

    const r2 = await post("/auth/refresh", { cookie: cookieHeader(second) });
    expect(r2.status).toBe(200);
    const third = setCookie(r2.headers)!.value;

    const replay = await post("/auth/refresh", { cookie: cookieHeader(first) });
    expect({ status: replay.status, body: replay.body }).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect(setCookie(replay.headers)!.raw).toContain("Max-Age=0");
    expect((await sessionRow(sessionOf(first))).revokedAt).not.toBeNull();
    expect((await post("/auth/refresh", { cookie: cookieHeader(third) })).status).toBe(401);
  });

  it("8. a forged cookie with a real tenantId/sessionId but a random secret is rejected and revokes nothing", async () => {
    const { refresh } = await loggedIn();
    const [, tenantId, sessionId] = refresh.split(".") as [string, string, string];
    const rand = () => randomBytes(32).toString("base64url");
    for (const forged of [`rt1.${tenantId}.${sessionId}.${rand()}.${rand()}`, `rt1.${tenantId}.${sessionId}.${rand()}.${refresh.split(".")[4]}`, "garbage"]) {
      const res = await post("/auth/refresh", { cookie: cookieHeader(forged) });
      expect(res.status).toBe(401);
      expect(setCookie(res.headers)!.raw).toContain("Max-Age=0");
      await post("/auth/logout", { cookie: cookieHeader(forged) }); // logout with a forged token is a no-op too
    }
    expect((await sessionRow(sessionId)).revokedAt).toBeNull();
    expect(await owner.auditLog.count({ where: { resourceId: sessionId, action: { in: ["auth.refresh.replay_detected", "auth.session.revoked"] } } })).toBe(0);
    expect((await post("/auth/refresh", { cookie: cookieHeader(refresh) })).status).toBe(200);
  });

  it("refresh without cookie, or with the cookie twice (ambiguous), is 401", async () => {
    const { refresh } = await loggedIn();
    expect((await post("/auth/refresh")).status).toBe(401);
    expect((await post("/auth/refresh", { cookie: `${cookieHeader(refresh)}; ${cookieHeader(refresh)}` })).status).toBe(401);
    expect((await sessionRow(sessionOf(refresh))).revokedAt).toBeNull();
  });

  it("9/10. logout revokes the session of the cookie, clears the cookie, and the access token stops working", async () => {
    const { refresh, accessToken } = await loggedIn();
    const res = await post("/auth/logout", { cookie: cookieHeader(refresh) });
    expect(res.status).toBe(204);
    const cleared = setCookie(res.headers)!.raw;
    expect(cleared).toMatch(new RegExp(`^${COOKIE}=;`));
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/auth");
    expect((await sessionRow(sessionOf(refresh))).revokedAt).not.toBeNull();
    expect((await http.request("/http-probe", { token: accessToken })).status).toBe(401);
    expect((await post("/auth/refresh", { cookie: cookieHeader(refresh) })).status).toBe(401);
    expect((await post("/auth/logout", { cookie: cookieHeader(refresh) })).status).toBe(204); // idempotent
    expect((await post("/auth/logout")).status).toBe(204); // no cookie: still 204, cookie cleared
  });

  it("CSRF: login, refresh and logout refuse foreign, null and cross-site origins", async () => {
    const { refresh, user } = await loggedIn();
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "http://app.example.test" }]) {
      for (const path of ["/auth/refresh", "/auth/logout"]) {
        const res = await post(path, { cookie: cookieHeader(refresh), headers });
        expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 403, body: { error: "forbidden_origin" } });
      }
      expect((await login(orgA.loginCode, user.employeeNumber, DEFAULT_PASSWORD, headers)).status).toBe(403);
    }
    // No Origin but a browser fetch-metadata header saying cross-site.
    const crossSite = await http.requestWithHeaders("/auth/refresh", { method: "POST", headers: { cookie: cookieHeader(refresh), "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect((await sessionRow(sessionOf(refresh))).revokedAt).toBeNull();
  });

  it("11. trial: allowed while trial_ends_at is absent or in the future, blocked once it expired (login, refresh and requests)", async () => {
    const future = await seedOrg(owner, "Trial future", TenantStatus.TRIAL, { trialEndsAt: new Date(Date.now() + 86_400_000) });
    const open = await seedOrg(owner, "Trial open", TenantStatus.TRIAL);
    const expired = await seedOrg(owner, "Trial expired", TenantStatus.TRIAL, { trialEndsAt: new Date(Date.now() - 1000) });
    expect((await loggedIn(future)).res.status).toBe(200);
    expect((await loggedIn(open)).res.status).toBe(200);
    const user = await seedUser(owner, expired.tenantId);
    const res = await login(expired.loginCode, user.employeeNumber);
    expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { error: "tenant_unavailable" } });
    expect(setCookie(res.headers)).toBeNull();

    // A trial that expires during the session blocks refresh and requests too.
    const ending = await seedOrg(owner, "Trial ending", TenantStatus.TRIAL, { trialEndsAt: new Date(Date.now() + 86_400_000) });
    const s = await loggedIn(ending);
    await owner.tenant.update({ where: { id: ending.tenantId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect((await post("/auth/refresh", { cookie: cookieHeader(s.refresh) })).status).toBe(403);
    expect((await http.request("/http-probe", { token: s.accessToken })).status).toBe(403);
  });

  it("12/13/14. PAST_DUE logs in; SUSPENDED and CANCELLED are blocked", async () => {
    expect((await loggedIn(await seedOrg(owner, "Past due", TenantStatus.PAST_DUE))).res.status).toBe(200);
    for (const status of [TenantStatus.SUSPENDED, TenantStatus.CANCELLED]) {
      const org = await seedOrg(owner, status, status);
      const user = await seedUser(owner, org.tenantId);
      const res = await login(org.loginCode, user.employeeNumber);
      expect({ status: res.status, body: res.body }, status).toEqual({ status: 403, body: { error: "tenant_unavailable" } });
    }
  });

  it("15. employee number: trimmed and uppercased on login, leading zeros preserved", async () => {
    await seedUser(owner, orgA.tenantId, { employeeNumber: "MOR-007" });
    expect((await login(orgA.loginCode, "  mor-007 ")).status).toBe(200);
    expect((await login(orgA.loginCode, "MOR-7")).status).toBe(401);
    expect((await login(orgA.loginCode, "MOR 007")).status).toBe(401);
    expect((await login(orgA.loginCode, "ımor-007")).status).toBe(401);
  });

  it("16. cross-tenant: the same employee number only authenticates in the tenant of the code", async () => {
    await seedUser(owner, orgA.tenantId, { employeeNumber: "SHARED-9", password: "Senha-Tenant-A-1" });
    await seedUser(owner, orgB.tenantId, { employeeNumber: "SHARED-9", password: "Senha-Tenant-B-1" });
    expect((await login(orgA.loginCode, "SHARED-9", "Senha-Tenant-B-1")).status).toBe(401);
    expect((await login(orgB.loginCode, "SHARED-9", "Senha-Tenant-A-1")).status).toBe(401);
    const b = await login(orgB.loginCode, "shared-9", "Senha-Tenant-B-1");
    expect(b.status).toBe(200);
    const token = (b.body as { accessToken: string }).accessToken;
    const [, payload] = token.split(".") as [string, string];
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).tid).toBe(orgB.tenantId);
    // A refresh cookie of tenant B never refreshes into tenant A.
    const refreshB = setCookie(b.headers)!.value;
    const swapped = refreshB.replace(orgB.tenantId, orgA.tenantId);
    expect((await post("/auth/refresh", { cookie: cookieHeader(swapped) })).status).toBe(401);
  });
});
