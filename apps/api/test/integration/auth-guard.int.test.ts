import { setTimeout as sleep } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { Controller, Get, Inject, Param, Post, SetMetadata } from "@nestjs/common";
import { PRISMA_CLIENT } from "../../src/database/database.module.js";
import { TenantScope } from "../../src/tenancy/tenant-scope.js";
import { base64url } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DeviceStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import type { IssuedTokens } from "../../src/auth/auth.service.js";
import { AuthContextService, type AuthContext } from "../../src/auth/context/auth-context.js";
import { CurrentAuth, IS_PUBLIC, Public } from "../../src/auth/http/auth-decorators.js";
import { TenantContextService } from "../../src/tenancy/tenant-context.js";
import { authHarness, expireSession, seedDevice, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

/** Misuse: the public mark applied to a whole class. The guard must ignore it. */
@Controller("class-marked-public")
@(SetMetadata(IS_PUBLIC, true) as ClassDecorator)
class ClassMarkedPublicController {
  @Get()
  get(): unknown {
    return { leaked: true };
  }
}

class PublicBase {
  @Public()
  @Get("open")
  open(): unknown {
    return { base: true };
  }
}

/** Child overriding an inherited public method without the mark: the override is protected. */
@Controller("child")
class ChildController extends PublicBase {
  @Get("open")
  override open(): unknown {
    return { leaked: true };
  }
}

/** Context under load: a real transaction, Promise.all, nested awaits and failures inside the handler. */
@Controller("stress")
class StressController {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  @Get(":mode")
  async run(@Param("mode") mode: string): Promise<unknown> {
    const seen = await this.prisma.$transaction(async (tx) => {
      const [users, sessions] = await Promise.all([
        tx.user.count({ where: this.scope.where({}) }),
        (async () => {
          await sleep(Math.floor(Math.random() * 5));
          return tx.session.count({ where: this.scope.where({ id: this.auth.require().sessionId }) });
        })(),
      ]);
      return { tenantId: this.scope.tenantId(), users, sessions };
    });
    await sleep(Math.floor(Math.random() * 5));
    if (mode === "fail") throw new Error("handler failure");
    return { ...seen, after: this.auth.require().tenantId };
  }
}

@Controller("probe")
class ProbeController {
  constructor(
    @Inject(AuthContextService) private readonly auth: AuthContextService,
    @Inject(TenantContextService) private readonly tenants: TenantContextService,
  ) {}

  /** Reads both contexts after an await, like any real service would. */
  @Get("whoami")
  async whoami(@CurrentAuth() fromRequest: AuthContext): Promise<unknown> {
    await sleep(Math.floor(Math.random() * 15));
    const auth = this.auth.require();
    return { auth, tenantId: this.tenants.requireTenantId(), sameAsRequest: auth === fromRequest || JSON.stringify(auth) === JSON.stringify(fromRequest) };
  }

  @Post("whoami")
  async whoamiPost(): Promise<unknown> {
    return { tenantId: this.tenants.requireTenantId() };
  }

  @Public()
  @Get("public")
  open(): unknown {
    return { tenant: this.tenants.current() ?? null, auth: this.auth.current() ?? null };
  }
}

// M2.7: global AuthGuard + AuthContextInterceptor + filter through real HTTP, as erp_app.
describe("AuthGuard over HTTP (PostgreSQL, as erp_app)", () => {
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;

  beforeAll(async () => {
    prisma = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(prisma, config);
    http = await startHttpApp(prisma, config, [ProbeController, ClassMarkedPublicController, ChildController, StressController]);
    orgA = await seedOrg(owner, "Guard A");
    orgB = await seedOrg(owner, "Guard B");
  });

  afterAll(async () => {
    await http?.close(); // also disconnects `prisma` (DatabaseModule lifecycle)
    await owner.$disconnect();
  });

  async function loginNew(org: Org = orgA, input: { mustChangePassword?: boolean; deviceKey?: string } = {}): Promise<IssuedTokens> {
    const user = await seedUser(owner, org.tenantId, input.mustChangePassword ? { mustChangePassword: true } : {});
    return h.auth.login(
      { tenantId: org.tenantId },
      { employeeNumber: user.employeeNumber, password: "Senha-Correta-123", ...(input.deviceKey ? { deviceKey: input.deviceKey } : {}) },
    );
  }

  it("denies by default: no token, malformed header or garbage -> 401 with only a public code", async () => {
    expect(await http.request("/probe/whoami")).toEqual({ status: 401, body: { error: "unauthenticated" } });
    for (const authorization of ["Basic abc", "Bearer", "Bearer a.b", "bearer x.y.z", "Token x.y.z", `Bearer ${"a".repeat(5000)}.b.c`]) {
      const res = await http.request("/probe/whoami", { headers: { authorization } });
      expect(res, authorization.slice(0, 20)).toEqual({ status: 401, body: { error: "unauthenticated" } });
    }
    expect((await http.request("/health")).status).toBe(200);
    expect(await http.request("/probe/public")).toEqual({ status: 200, body: { tenant: null, auth: null } });
  });

  it("public marks only count on the handler: never from the class, never through inheritance of an overridden method", async () => {
    expect(await http.request("/class-marked-public")).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect(await http.request("/child/open")).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("duplicate Authorization headers never authenticate, in any order (Node keeps only the first; a proxy may read the last)", async () => {
    const tokens = await loginNew();
    const raw = (headers: [string, string][]) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(`${http.baseUrl}/probe/whoami`);
        const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: [["host", url.host], ...headers].flat() as never }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once("error", reject);
        req.end();
      });
    // Without the guard's duplicate check, the second request would be 200 (Node silently keeps the first header).
    expect(await raw([["authorization", "Bearer garbage.garbage.garbage"], ["authorization", `Bearer ${tokens.accessToken}`]])).toBe(401);
    expect(await raw([["authorization", `Bearer ${tokens.accessToken}`], ["authorization", "Bearer garbage.garbage.garbage"]])).toBe(401);
    expect(await raw([["authorization", `Bearer ${tokens.accessToken}`]])).toBe(200);
    expect(await raw([["authorization", `Bearer ${tokens.accessToken}, Bearer ${tokens.accessToken}`]])).toBe(401);
  });

  it("builds the tenant and auth contexts from the verified token and session only", async () => {
    const tokens = await loginNew();
    const res = await http.request("/probe/whoami", { token: tokens.accessToken });
    expect(res).toEqual({
      status: 200,
      body: {
        auth: { tenantId: orgA.tenantId, userId: tokens.userId, sessionId: tokens.sessionId, deviceId: null, mustChangePassword: false },
        tenantId: orgA.tenantId,
        sameAsRequest: true,
      },
    });
  });

  it("never switches the tenant context to a tenant sent by the client (header, query, body)", async () => {
    const tokens = await loginNew(orgA);
    const res = await http.request(`/probe/whoami?tenantId=${orgB.tenantId}&tenant_id=${orgB.tenantId}`, {
      token: tokens.accessToken,
      headers: { "x-tenant-id": orgB.tenantId, "x-tenant": orgB.tenantId },
    });
    expect((res.body as { tenantId: string }).tenantId).toBe(orgA.tenantId);
    const post = await http.request("/probe/whoami", { method: "POST", token: tokens.accessToken, body: { tenantId: orgB.tenantId } });
    expect(post.body).toEqual({ tenantId: orgA.tenantId });
  });

  it("rejects access tokens with tampered claims (tenant, user, session, expiry)", async () => {
    const a = await loginNew(orgA);
    const b = await loginNew(orgB);
    const tamper = (token: string, patch: Record<string, unknown>) => {
      const [header, payload, signature] = token.split(".") as [string, string, string];
      const claims = { ...(JSON.parse(new TextDecoder().decode(base64url.decode(payload))) as object), ...patch };
      return [header, base64url.encode(JSON.stringify(claims)), signature].join(".");
    };
    for (const forged of [
      tamper(a.accessToken, { tid: orgB.tenantId }),
      tamper(a.accessToken, { tid: orgB.tenantId, sid: b.sessionId, sub: b.userId }),
      tamper(a.accessToken, { sub: b.userId }),
      tamper(a.accessToken, { exp: 9_999_999_999 }),
    ]) {
      expect(await http.request("/probe/whoami", { token: forged })).toEqual({ status: 401, body: { error: "unauthenticated" } });
    }
  });

  it("a validly signed token whose session belongs to another user or device is refused (User A cannot use Session B)", async () => {
    const a = await loginNew(orgA);
    const b = await loginNew(orgA);
    const device = await seedDevice(owner, orgA.tenantId);
    const signed = async (patch: Partial<{ userId: string; sessionId: string; tenantId: string; deviceId: string | null }>) =>
      (await h.accessTokens.issue({ tenantId: orgA.tenantId, userId: a.userId, sessionId: a.sessionId, deviceId: null, ...patch })).token;
    expect((await http.request("/probe/whoami", { token: await signed({ sessionId: b.sessionId }) })).status).toBe(401);
    expect((await http.request("/probe/whoami", { token: await signed({ deviceId: device.id }) })).status).toBe(401);
    // Session of tenant A looked up in tenant B's scope: not found.
    expect((await http.request("/probe/whoami", { token: await signed({ tenantId: orgB.tenantId }) })).status).toBe(401);
    expect((await http.request("/probe/whoami", { token: await signed({}) })).status).toBe(200);
  });

  it("stops accepting the access token as soon as the session is revoked, expired or the user/device/tenant is blocked", async () => {
    const loggedOut = await loginNew();
    // Logout is driven by the refresh cookie (HTTP transport decision); a Bearer alone does not identify what to revoke.
    const logout = await http.request("/auth/logout", { method: "POST", headers: { cookie: `__Secure-erp_rt=${loggedOut.refreshToken}` } });
    expect(logout.status).toBe(204);
    expect(await http.request("/probe/whoami", { token: loggedOut.accessToken })).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect((await owner.session.findUniqueOrThrow({ where: { id: loggedOut.sessionId } })).revokedAt).not.toBeNull();

    const expired = await loginNew();
    await expireSession(owner, expired.sessionId);
    expect((await http.request("/probe/whoami", { token: expired.accessToken })).status).toBe(401);

    for (const status of [UserStatus.DISABLED, UserStatus.LOCKED]) {
      const tokens = await loginNew();
      await owner.user.update({ where: { id: tokens.userId }, data: { status } });
      expect((await http.request("/probe/whoami", { token: tokens.accessToken })).status).toBe(401);
    }

    const device = await seedDevice(owner, orgA.tenantId);
    const withDevice = await loginNew(orgA, { deviceKey: device.deviceKey });
    expect((await http.request("/probe/whoami", { token: withDevice.accessToken })).body).toMatchObject({ auth: { deviceId: device.id } });
    await owner.device.update({ where: { id: device.id }, data: { status: DeviceStatus.REVOKED } });
    expect(await http.request("/probe/whoami", { token: withDevice.accessToken })).toEqual({ status: 403, body: { error: "device_not_allowed" } });

    const org = await seedOrg(owner, "Guard suspended");
    const tokens = await loginNew(org);
    await owner.tenant.update({ where: { id: org.tenantId }, data: { status: TenantStatus.SUSPENDED } });
    expect(await http.request("/probe/whoami", { token: tokens.accessToken })).toEqual({ status: 403, body: { error: "tenant_unavailable" } });
  });

  it("with must_change_password only routes marked for it are reachable", async () => {
    const tokens = await loginNew(orgA, { mustChangePassword: true });
    expect(await http.request("/probe/whoami", { token: tokens.accessToken })).toEqual({ status: 403, body: { error: "password_change_required" } });
    expect((await http.request("/auth/logout", { method: "POST", token: tokens.accessToken })).status).toBe(204);
  });

  it("stress: 300 concurrent requests of three tenants with transactions, Promise.all and failures never mix contexts", async () => {
    const orgC = await seedOrg(owner, "Guard C");
    const tokens = [await loginNew(orgA), await loginNew(orgB), await loginNew(orgC)];
    const plan = Array.from({ length: 300 }, (_, i) => ({ t: tokens[i % 3]!, fail: i % 7 === 0 }));
    // At most 60 in flight (Windows refuses bursts of hundreds of simultaneous TCP connects); still heavily interleaved.
    const responses: { status: number; body: unknown }[] = new Array(plan.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: 60 }, async () => {
        while (next < plan.length) {
          const i = next++;
          const { t, fail } = plan[i]!;
          responses[i] = await http.request(`/stress/${fail ? "fail" : "ok"}`, { token: t.accessToken });
        }
      }),
    );
    responses.forEach((res, i) => {
      const { t, fail } = plan[i]!;
      if (fail) {
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("handler failure");
      } else {
        expect(res).toMatchObject({ status: 200, body: { tenantId: t.tenantId, after: t.tenantId, sessions: 1 } });
      }
    });
    expect(await http.request("/probe/public")).toEqual({ status: 200, body: { tenant: null, auth: null } });
  });

  it("isolates contexts across many concurrent requests of two tenants and leaks nothing afterwards", async () => {
    const a = await loginNew(orgA);
    const b = await loginNew(orgB);
    const calls = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? a : b));
    const responses = await Promise.all(calls.map((t) => http.request("/probe/whoami", { token: t.accessToken })));
    responses.forEach((res, i) => {
      const expected = calls[i]!;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tenantId: expected.tenantId, auth: { tenantId: expected.tenantId, userId: expected.userId, sessionId: expected.sessionId } });
    });
    expect(await http.request("/probe/public")).toEqual({ status: 200, body: { tenant: null, auth: null } });
  });
});
