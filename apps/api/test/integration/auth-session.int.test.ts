import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DeviceStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import type { IssuedTokens } from "../../src/auth/auth.service.js";
import { AuthContextMissingError } from "../../src/auth/context/auth-context.js";
import {
  DeviceNotAllowedError,
  InvalidRefreshTokenError,
  RefreshTokenReplayError,
  SessionExpiredError,
  SessionRevokedError,
  TenantUnavailableError,
  UnauthenticatedError,
} from "../../src/auth/errors.js";
import { SessionService } from "../../src/auth/session.service.js";
import { PasswordService } from "../../src/auth/password.service.js";
import { parseRefreshToken } from "../../src/auth/tokens/refresh-token.js";
import { authHarness, containsSecret, expireSession, seedDevice, seedOrg, seedUser, type AuthHarness, type Org } from "./auth-fixtures.js";

// M2.5 / M2.6: refresh rotation, replay handling, logout and revocation, as erp_app.
describe("refresh, rotation, replay and revocation (PostgreSQL, as erp_app)", () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let sessions: SessionService;
  let orgA: Org;
  let orgB: Org;

  beforeAll(async () => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    h = authHarness(app);
    sessions = new SessionService(app, h.scope, h.authContext);
    orgA = await seedOrg(owner, "Refresh A");
    orgB = await seedOrg(owner, "Refresh B");
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  async function loginNew(org: Org = orgA, extra: { deviceKey?: string } = {}): Promise<IssuedTokens> {
    const user = await seedUser(owner, org.tenantId);
    return h.auth.login({ tenantId: org.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123", ...extra });
  }

  const sessionRow = (id: string) => owner.session.findUniqueOrThrow({ where: { id } });

  it("rotates: the new refresh token works, the old one stops working and replaying it revokes the session", async () => {
    const first = await loginNew();
    const second = await h.auth.refresh(first.refreshToken);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshTokenExpiresAt.getTime()).toBe(first.refreshTokenExpiresAt.getTime()); // absolute lifetime
    expect((await h.accessTokens.verify(second.accessToken)).sessionId).toBe(first.sessionId);

    const third = await h.auth.refresh(second.refreshToken);
    expect((await sessionRow(first.sessionId)).revokedAt).toBeNull();

    await expect(h.auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(RefreshTokenReplayError);
    expect((await sessionRow(first.sessionId)).revokedAt).not.toBeNull();
    await expect(h.auth.refresh(third.refreshToken)).rejects.toBeInstanceOf(SessionRevokedError);
    await expect(h.auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(SessionRevokedError);

    const audit = await owner.auditLog.findMany({ where: { tenantId: orgA.tenantId, resourceId: first.sessionId } });
    expect(audit.map((a) => a.action).sort()).toEqual(["auth.login.succeeded", "auth.refresh.replay_detected", "auth.session.revoked"]);
    expect(containsSecret(audit, [first.refreshToken, second.refreshToken, third.refreshToken, parseRefreshToken(h.config.refreshTokenProofKey, first.refreshToken)!.secret])).toBe(false);
  });

  it("lets at most one of many concurrent refreshes with the same token rotate it", async () => {
    for (const parallel of [2, 5]) {
      const tokens = await loginNew();
      const results = await Promise.allSettled(Array.from({ length: parallel }, () => h.auth.refresh(tokens.refreshToken)));
      const ok = results.filter((r): r is PromiseFulfilledResult<IssuedTokens> => r.status === "fulfilled");
      expect(ok.length, `parallel=${parallel}`).toBeLessThanOrEqual(1);
      for (const r of results) {
        if (r.status === "rejected") expect([RefreshTokenReplayError, SessionRevokedError].some((E) => r.reason instanceof E)).toBe(true);
      }
      // A losing refresh is treated as reuse: the session is revoked, so even the winner's token is dead.
      expect((await sessionRow(tokens.sessionId)).revokedAt).not.toBeNull();
      if (ok[0]) await expect(h.auth.refresh(ok[0].value.refreshToken)).rejects.toBeInstanceOf(SessionRevokedError);
    }
  });

  it("revocation racing a refresh always leaves the session revoked and unusable", async () => {
    for (let i = 0; i < 5; i++) {
      const tokens = await loginNew();
      const [refreshed] = await Promise.allSettled([
        h.auth.refresh(tokens.refreshToken),
        h.tenants.run({ tenantId: orgA.tenantId }, () => sessions.revokeSession(tokens.sessionId, "admin", null)),
      ]);
      expect((await sessionRow(tokens.sessionId)).revokedAt).not.toBeNull();
      if (refreshed.status === "fulfilled") await expect(h.auth.refresh(refreshed.value.refreshToken)).rejects.toBeInstanceOf(SessionRevokedError);
      else expect(refreshed.reason).toBeInstanceOf(SessionRevokedError);
    }
  });

  it("a refresh token never resolves a session of another tenant, and tampered tokens revoke nothing", async () => {
    const a = await loginNew(orgA);
    const b = await loginNew(orgB);
    const [, , , secretA, proofA] = a.refreshToken.split(".") as [string, string, string, string, string];
    const [, , , secretB, proofB] = b.refreshToken.split(".") as [string, string, string, string, string];

    for (const forged of [
      `rt1.${orgB.tenantId}.${a.sessionId}.${secretA}.${proofA}`, // session of A claimed in tenant B
      `rt1.${orgA.tenantId}.${b.sessionId}.${secretB}.${proofB}`, // session of B claimed in tenant A
      `rt1.${orgA.tenantId}.${a.sessionId}.${secretB}.${proofB}`, // real secret of B on the session of A
      `rt1.${orgA.tenantId}.${a.sessionId}.${secretB}.${proofA}`,
    ]) {
      await expect(h.auth.refresh(forged)).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    }
    expect((await sessionRow(a.sessionId)).revokedAt).toBeNull();
    expect((await sessionRow(b.sessionId)).revokedAt).toBeNull();
    expect((await h.auth.refresh(a.refreshToken)).tenantId).toBe(orgA.tenantId);
    expect((await h.auth.refresh(b.refreshToken)).tenantId).toBe(orgB.tenantId);
  });

  it("knowing tenantId + sessionId (both in the access token) is not enough to revoke the session", async () => {
    const victim = await loginNew(orgA);
    const claims = await h.accessTokens.verify(victim.accessToken); // what an attacker could read from a leaked access token or log
    const [, , , , realProof] = victim.refreshToken.split(".") as [string, string, string, string, string];
    for (let i = 0; i < 20; i++) {
      const guess = randomBytes(32).toString("base64url");
      const proof = i % 2 === 0 ? randomBytes(32).toString("base64url") : realProof;
      await expect(h.auth.refresh(`rt1.${claims.tenantId}.${claims.sessionId}.${guess}.${proof}`)).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    }
    expect((await sessionRow(victim.sessionId)).revokedAt).toBeNull();
    expect(await owner.auditLog.count({ where: { resourceId: victim.sessionId, action: "auth.refresh.replay_detected" } })).toBe(0);
    await h.auth.refresh(victim.refreshToken);
  });

  it("revokeAll and password reset racing a refresh always leave the session revoked and unusable", async () => {
    const passwords = new PasswordService(app, h.scope, h.authContext, h.hasher);
    for (const race of ["revokeAll", "reset"] as const) {
      for (let i = 0; i < 5; i++) {
        const tokens = await loginNew();
        const actor = { tenantId: orgA.tenantId, userId: tokens.userId, sessionId: tokens.sessionId, deviceId: null, mustChangePassword: false };
        const competing =
          race === "revokeAll"
            ? h.tenants.run({ tenantId: orgA.tenantId }, () => sessions.revokeAllForUser(tokens.userId, "admin", null))
            : h.authContext.run(actor, () => passwords.resetPassword(tokens.userId, "Temporaria-Corrida-1"));
        const [refreshed, other] = await Promise.allSettled([h.auth.refresh(tokens.refreshToken), competing]);
        expect(other.status, race).toBe("fulfilled");
        expect((await sessionRow(tokens.sessionId)).revokedAt, race).not.toBeNull();
        if (refreshed.status === "fulfilled") await expect(h.auth.refresh(refreshed.value.refreshToken)).rejects.toBeInstanceOf(SessionRevokedError);
        else expect(refreshed.reason, race).toBeInstanceOf(SessionRevokedError);
      }
    }
  });

  it("rejects garbage refresh tokens without touching any session", async () => {
    for (const token of ["", "rt1", "rt1.x.y.z", "a".repeat(5000), undefined as never]) {
      await expect(h.auth.refresh(token)).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    }
  });

  it("refuses expired sessions, disabled/locked users, revoked devices and suspended tenants", async () => {
    const expired = await loginNew();
    await expireSession(owner, expired.sessionId);
    await expect(h.auth.refresh(expired.refreshToken)).rejects.toBeInstanceOf(SessionExpiredError);

    for (const status of [UserStatus.DISABLED, UserStatus.LOCKED]) {
      const tokens = await loginNew();
      await owner.user.update({ where: { id: tokens.userId }, data: { status } });
      await expect(h.auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    }

    // A temporary lock (someone guessing the password) does not kill the user's existing sessions.
    const temp = await loginNew();
    await owner.user.update({ where: { id: temp.userId }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    await h.auth.refresh(temp.refreshToken);

    for (const status of [DeviceStatus.REVOKED, DeviceStatus.INACTIVE]) {
      const device = await seedDevice(owner, orgA.tenantId);
      const tokens = await loginNew(orgA, { deviceKey: device.deviceKey });
      await owner.device.update({ where: { id: device.id }, data: { status } });
      await expect(h.auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(DeviceNotAllowedError);
    }

    const org = await seedOrg(owner, "Soon suspended");
    const tokens = await loginNew(org);
    await owner.tenant.update({ where: { id: org.tenantId }, data: { status: TenantStatus.SUSPENDED } });
    await expect(h.auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(TenantUnavailableError);
  });

  it("logout revokes the current session only, idempotently, and never deletes it", async () => {
    const tokens = await loginNew();
    const other = await h.auth.login({ tenantId: orgA.tenantId }, { employeeNumber: (await owner.user.findUniqueOrThrow({ where: { id: tokens.userId } })).employeeNumber, password: "Senha-Correta-123" });
    const auth = { tenantId: orgA.tenantId, userId: tokens.userId, sessionId: tokens.sessionId, deviceId: null, mustChangePassword: false };

    await h.authContext.run(auth, () => sessions.logout());
    await h.authContext.run(auth, () => sessions.logout());
    const row = await sessionRow(tokens.sessionId);
    expect(row.revokedAt).not.toBeNull();
    expect((await sessionRow(other.sessionId)).revokedAt).toBeNull();
    await expect(h.auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(SessionRevokedError);
    const revokedEvents = await owner.auditLog.findMany({ where: { action: "auth.session.revoked", resourceId: tokens.sessionId } });
    expect(revokedEvents).toHaveLength(1);
    expect(revokedEvents[0]?.metadata).toEqual({ reason: "logout" });

    await expect(sessions.logout()).rejects.toBeInstanceOf(AuthContextMissingError);
  });

  it("revokes all sessions of a user, optionally keeping one, and only inside the current tenant", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const login = () => h.auth.login({ tenantId: orgA.tenantId }, { employeeNumber: user.employeeNumber, password: "Senha-Correta-123" });
    const [s1, s2, s3] = [await login(), await login(), await login()];

    // From tenant B, A's user and sessions do not exist.
    expect(await h.tenants.run({ tenantId: orgB.tenantId }, () => sessions.revokeAllForUser(user.id, "admin", null))).toBe(0);
    expect(await h.tenants.run({ tenantId: orgB.tenantId }, () => sessions.revokeSession(s1.sessionId, "admin", null))).toBe(false);
    expect((await sessionRow(s1.sessionId)).revokedAt).toBeNull();

    expect(await h.tenants.run({ tenantId: orgA.tenantId }, () => sessions.revokeAllForUser(user.id, "admin", null, { exceptSessionId: s3.sessionId }))).toBe(2);
    expect((await sessionRow(s1.sessionId)).revokedAt).not.toBeNull();
    expect((await sessionRow(s2.sessionId)).revokedAt).not.toBeNull();
    expect((await sessionRow(s3.sessionId)).revokedAt).toBeNull();
    expect(await h.tenants.run({ tenantId: orgA.tenantId }, () => sessions.revokeAllForUser(user.id, "admin", null))).toBe(1);
    expect(await h.tenants.run({ tenantId: orgA.tenantId }, () => sessions.revokeAllForUser(user.id, "admin", null))).toBe(0);
  });

  it("revokes every session bound to a device", async () => {
    const device = await seedDevice(owner, orgA.tenantId);
    const t1 = await loginNew(orgA, { deviceKey: device.deviceKey });
    const t2 = await loginNew(orgA, { deviceKey: device.deviceKey });
    const unrelated = await loginNew(orgA);
    expect(await h.tenants.run({ tenantId: orgA.tenantId }, () => sessions.revokeAllForDevice(device.id))).toBe(2);
    for (const t of [t1, t2]) expect((await sessionRow(t.sessionId)).revokedAt).not.toBeNull();
    expect((await sessionRow(unrelated.sessionId)).revokedAt).toBeNull();
  });
});
