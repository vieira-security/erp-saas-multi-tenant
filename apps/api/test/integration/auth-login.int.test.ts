import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { DeviceStatus, TenantStatus, UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { AUTH_SECURITY_POLICY } from "../../src/auth/auth-security-policy.js";
import {
  AccountDisabledError,
  AccountLockedError,
  DeviceNotAllowedError,
  InvalidCredentialsError,
  TenantUnavailableError,
} from "../../src/auth/errors.js";
import { ARGON2ID_PARAMS } from "../../src/auth/password/password-hasher.js";
import { parseRefreshToken } from "../../src/auth/tokens/refresh-token.js";
import {
  DEFAULT_PASSWORD,
  authHarness,
  containsSecret,
  seedDevice,
  seedOrg,
  seedUser,
  type AuthHarness,
  type Org,
} from "./auth-fixtures.js";

// M2.3 / M2.8 / M2.13: login by employee number + password inside a resolved tenant, as erp_app.
describe("login (PostgreSQL, as erp_app)", () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let orgA: Org;
  let orgB: Org;

  beforeAll(async () => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    h = authHarness(app);
    orgA = await seedOrg(owner, "Login A");
    orgB = await seedOrg(owner, "Login B");
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  const login = (org: Org, employeeNumber: string, password = DEFAULT_PASSWORD, extra: { deviceKey?: string } = {}) =>
    h.auth.login({ tenantId: org.tenantId }, { employeeNumber, password, ...extra, client: { ipAddress: "10.0.0.7", userAgent: "vitest" } });

  const auditOf = (tenantId: string, action: string) => owner.auditLog.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" } });

  it("authenticates, creates a session with only the refresh hash and records the login", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const before = new Date();
    const tokens = await login(orgA, user.employeeNumber);

    expect(tokens).toMatchObject({ tenantId: orgA.tenantId, userId: user.id, deviceId: null, mustChangePassword: false });
    const verified = await h.accessTokens.verify(tokens.accessToken);
    expect(verified).toMatchObject({ tenantId: orgA.tenantId, userId: user.id, sessionId: tokens.sessionId, deviceId: null });

    const parsed = parseRefreshToken(tokens.refreshToken);
    expect(parsed).toMatchObject({ tenantId: orgA.tenantId, sessionId: tokens.sessionId });
    const session = await owner.session.findUniqueOrThrow({ where: { id: tokens.sessionId } });
    expect(session).toMatchObject({ tenantId: orgA.tenantId, userId: user.id, deviceId: null, revokedAt: null, ipAddress: "10.0.0.7", userAgent: "vitest" });
    expect(session.refreshTokenHash).toMatch(/^sha256\$/);
    expect(containsSecret(session, [parsed!.secret, tokens.refreshToken, tokens.accessToken])).toBe(false);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThan(h.config.refreshTokenTtlSeconds * 1000 - 5000);

    const row = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });

    const audits = (await auditOf(orgA.tenantId, "auth.login.succeeded")).filter((a) => a.userId === user.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ resourceType: "session", resourceId: tokens.sessionId, metadata: null, ipAddress: "10.0.0.7" });
  });

  it("returns the same generic error for an unknown employee number and a wrong password, without leaking either", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const burn = vi.spyOn(h.hasher, "burnVerification");
    const unknown = await login(orgA, "NO-SUCH-EMPLOYEE").catch((e: unknown) => e);
    expect(burn).toHaveBeenCalledTimes(1); // timing equalization when there is no hash to verify
    burn.mockRestore();
    const wrong = await login(orgA, user.employeeNumber, "Senha-Errada").catch((e: unknown) => e);

    for (const error of [unknown, wrong]) {
      expect(error).toBeInstanceOf(InvalidCredentialsError);
      expect((error as InvalidCredentialsError).publicFailure).toEqual({ status: 401, code: "invalid_credentials" });
    }
    const failed = await auditOf(orgA.tenantId, "auth.login.failed");
    const unknownRow = failed.find((a) => a.userId === null);
    expect(unknownRow?.metadata).toEqual({ reason: "invalid_credentials" });
    expect(containsSecret(failed, ["NO-SUCH-EMPLOYEE", "Senha-Errada", DEFAULT_PASSWORD])).toBe(false);
    expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginAttempts).toBe(1);
  });

  it("employee numbers are unique per tenant: the same number authenticates only in its own tenant", async () => {
    const number = "SHARED-001";
    const a = await seedUser(owner, orgA.tenantId, { employeeNumber: number, password: "Senha-Do-A-123" });
    const b = await seedUser(owner, orgB.tenantId, { employeeNumber: number, password: "Senha-Do-B-123" });

    await expect(login(orgA, number, "Senha-Do-B-123")).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(login(orgB, number, "Senha-Do-A-123")).rejects.toBeInstanceOf(InvalidCredentialsError);
    const inA = await login(orgA, number, "Senha-Do-A-123");
    const inB = await login(orgB, number, "Senha-Do-B-123");
    expect([inA.userId, inA.tenantId]).toEqual([a.id, orgA.tenantId]);
    expect([inB.userId, inB.tenantId]).toEqual([b.id, orgB.tenantId]);
  });

  it("does not let DISABLED or LOCKED users in, even with the right password, and does not count those attempts", async () => {
    const disabled = await seedUser(owner, orgA.tenantId, { status: UserStatus.DISABLED });
    const locked = await seedUser(owner, orgA.tenantId, { status: UserStatus.LOCKED });
    const e1 = await login(orgA, disabled.employeeNumber).catch((e: unknown) => e);
    const e2 = await login(orgA, locked.employeeNumber).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AccountDisabledError);
    expect(e2).toBeInstanceOf(AccountLockedError);
    for (const e of [e1, e2]) expect((e as InvalidCredentialsError).publicFailure.code).toBe("invalid_credentials");
    for (const id of [disabled.id, locked.id]) {
      expect((await owner.user.findUniqueOrThrow({ where: { id } })).failedLoginAttempts).toBe(0);
      expect(await owner.session.count({ where: { userId: id } })).toBe(0);
    }
  });

  it("locks the account temporarily after the configured number of failures and unlocks after the period", async () => {
    const { maxFailedAttempts } = AUTH_SECURITY_POLICY.lockout;
    const user = await seedUser(owner, orgA.tenantId);
    for (let i = 0; i < maxFailedAttempts; i++) {
      await expect(login(orgA, user.employeeNumber, `wrong-${i}`)).rejects.toBeInstanceOf(InvalidCredentialsError);
    }
    const locked = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + AUTH_SECURITY_POLICY.lockout.durationMs - 60_000);
    expect(locked.failedLoginAttempts).toBe(0);
    expect(locked.status).toBe(UserStatus.ACTIVE); // the temporary lock never changes status
    expect((await auditOf(orgA.tenantId, "auth.lockout.triggered")).filter((a) => a.userId === user.id)).toHaveLength(1);

    // Right password during the lock: still refused, nothing counted (no password oracle during the lock).
    const during = await login(orgA, user.employeeNumber).catch((e: unknown) => e);
    expect(during).toBeInstanceOf(AccountLockedError);
    expect((during as AccountLockedError).reason).toBe("temporarily_locked");
    expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginAttempts).toBe(0);

    await owner.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000), failedLoginAttempts: 3 } });
    await login(orgA, user.employeeNumber);
    expect(await owner.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ lockedUntil: null, failedLoginAttempts: 0 });
  });

  it("counts concurrent failures without lost updates and locks exactly once", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const below = AUTH_SECURITY_POLICY.lockout.maxFailedAttempts - 1;
    await Promise.allSettled(Array.from({ length: below }, (_, i) => login(orgA, user.employeeNumber, `wrong-${i}`)));
    expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginAttempts).toBe(below);

    const other = await seedUser(owner, orgA.tenantId);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => login(orgA, other.employeeNumber, `wrong-${i}`)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const row = await owner.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(row.lockedUntil).not.toBeNull();
    const failures = (await auditOf(orgA.tenantId, "auth.login.failed")).filter((a) => a.userId === other.id);
    expect(failures).toHaveLength(12);
  });

  it("refuses tenants whose status does not allow authentication", async () => {
    const suspended = await seedOrg(owner, "Suspended", TenantStatus.SUSPENDED);
    const user = await seedUser(owner, suspended.tenantId);
    await expect(login(suspended, user.employeeNumber)).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(h.auth.login({ tenantId: "0199ffff-0000-7000-8000-000000000000" }, { employeeNumber: "x", password: "y" })).rejects.toBeInstanceOf(
      TenantUnavailableError,
    );
  });

  it("binds the session to an ACTIVE device of the same tenant and refuses revoked, inactive or foreign devices", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const device = await seedDevice(owner, orgA.tenantId, { branchId: orgA.branchId });
    const tokens = await login(orgA, user.employeeNumber, DEFAULT_PASSWORD, { deviceKey: device.deviceKey });
    expect(tokens.deviceId).toBe(device.id);
    expect((await h.accessTokens.verify(tokens.accessToken)).deviceId).toBe(device.id);
    expect((await owner.session.findUniqueOrThrow({ where: { id: tokens.sessionId } })).deviceId).toBe(device.id);

    const revoked = await seedDevice(owner, orgA.tenantId, { status: DeviceStatus.REVOKED });
    const inactive = await seedDevice(owner, orgA.tenantId, { status: DeviceStatus.INACTIVE });
    const foreign = await seedDevice(owner, orgB.tenantId); // device of tenant B, key used in tenant A
    for (const deviceKey of [revoked.deviceKey, inactive.deviceKey, foreign.deviceKey, "NO-SUCH-DEVICE", "x".repeat(1000)]) {
      await expect(login(orgA, user.employeeNumber, DEFAULT_PASSWORD, { deviceKey }), deviceKey.slice(0, 20)).rejects.toBeInstanceOf(DeviceNotAllowedError);
    }
    // The device check happens before the password: a bad device is not a password oracle and is not counted.
    await expect(login(orgA, user.employeeNumber, "wrong", { deviceKey: revoked.deviceKey })).rejects.toBeInstanceOf(DeviceNotAllowedError);
    expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginAttempts).toBe(0);
    expect(await owner.session.count({ where: { deviceId: { in: [revoked.id, inactive.id, foreign.id] } } })).toBe(0);
  });

  it("reports mustChangePassword on login", async () => {
    const user = await seedUser(owner, orgA.tenantId, { mustChangePassword: true });
    expect((await login(orgA, user.employeeNumber)).mustChangePassword).toBe(true);
  });

  it("rehashes on login when the stored hash uses older parameters", async () => {
    const weaker = await argon2.hash(DEFAULT_PASSWORD, { ...ARGON2ID_PARAMS, memoryCost: 8192, timeCost: 1 });
    const user = await seedUser(owner, orgA.tenantId, { passwordHash: weaker });
    await login(orgA, user.employeeNumber);
    const stored = (await owner.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;
    expect(stored).not.toBe(weaker);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    await login(orgA, user.employeeNumber);
  });

  it("treats oversized input and corrupted stored hashes as invalid credentials (never a 500 or a success)", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await expect(login(orgA, user.employeeNumber, "x".repeat(AUTH_SECURITY_POLICY.password.maxBytes + 1))).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(login(orgA, "E".repeat(1000))).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(login(orgA, user.employeeNumber, "")).rejects.toBeInstanceOf(InvalidCredentialsError);
    const corrupted = await seedUser(owner, orgA.tenantId, { passwordHash: "not-an-argon2-hash" });
    await expect(login(orgA, corrupted.employeeNumber, "not-an-argon2-hash")).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("never leaves the login's tenant context behind", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    await login(orgA, user.employeeNumber);
    expect(h.tenants.current()).toBeUndefined();
  });
});
