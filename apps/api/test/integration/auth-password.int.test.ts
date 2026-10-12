import { Controller, Get } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { UserStatus, type PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/database/create-prisma-client.js";
import { AUTH_SECURITY_POLICY } from "../../src/auth/auth-security-policy.js";
import { InvalidCredentialsError, PasswordPolicyError, UserNotFoundError } from "../../src/auth/errors.js";
import { PasswordService } from "../../src/auth/password.service.js";
import { DEFAULT_PASSWORD, authHarness, containsSecret, seedOrg, seedUser, testAuthConfig, type AuthHarness, type Org } from "./auth-fixtures.js";
import { startHttpApp, type HttpApp } from "./http-app.js";

@Controller("pw-probe")
class PasswordProbeController {
  @Get()
  ok(): unknown {
    return { ok: true };
  }
}

// M2.12: authenticated password change (HTTP) and administrative reset (service), as erp_app.
describe("password lifecycle (PostgreSQL, as erp_app)", () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let h: AuthHarness;
  let passwords: PasswordService;
  let http: HttpApp;
  let orgA: Org;
  let orgB: Org;

  beforeAll(async () => {
    app = createPrismaClient(inject("appDatabaseUrl"));
    owner = createPrismaClient(inject("databaseUrl"));
    const config = testAuthConfig();
    h = authHarness(app, config);
    passwords = new PasswordService(app, h.scope, h.authContext, h.hasher);
    http = await startHttpApp(createPrismaClient(inject("appDatabaseUrl")), config, [PasswordProbeController]);
    orgA = await seedOrg(owner, "Password A");
    orgB = await seedOrg(owner, "Password B");
  });

  afterAll(async () => {
    await http?.close();
    await app.$disconnect();
    await owner.$disconnect();
  });

  const login = (org: Org, employeeNumber: string, password = DEFAULT_PASSWORD) =>
    h.auth.login({ tenantId: org.tenantId }, { employeeNumber, password });
  const change = (token: string, body: unknown) => http.request("/auth/password", { method: "POST", token, body });
  const userRow = (id: string) => owner.user.findUniqueOrThrow({ where: { id } });

  it("changes the own password: only the hash is stored, other sessions are revoked, the current one stays", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const current = await login(orgA, user.employeeNumber);
    const other = await login(orgA, user.employeeNumber);
    const newPassword = "Nova-Senha-Segura-456";

    expect(await change(current.accessToken, { currentPassword: DEFAULT_PASSWORD, newPassword })).toEqual({ status: 204, body: null });

    const row = await userRow(user.id);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(newPassword);
    expect(row.mustChangePassword).toBe(false);
    expect((await owner.session.findUniqueOrThrow({ where: { id: other.sessionId } })).revokedAt).not.toBeNull();
    expect((await owner.session.findUniqueOrThrow({ where: { id: current.sessionId } })).revokedAt).toBeNull();
    expect((await http.request("/pw-probe", { token: current.accessToken })).status).toBe(200);
    expect((await http.request("/pw-probe", { token: other.accessToken })).status).toBe(401);

    await expect(login(orgA, user.employeeNumber)).rejects.toBeInstanceOf(InvalidCredentialsError);
    await login(orgA, user.employeeNumber, newPassword);

    const audit = await owner.auditLog.findMany({ where: { tenantId: orgA.tenantId, resourceId: user.id, action: { startsWith: "auth.s" } } });
    expect(audit.map((a) => [a.action, a.metadata])).toContainEqual(["auth.sessions.revoked", { reason: "password_changed", count: 1 }]);
    const all = await owner.auditLog.findMany({ where: { tenantId: orgA.tenantId } });
    expect(containsSecret(all, [newPassword, DEFAULT_PASSWORD, row.passwordHash])).toBe(false);
  });

  it("rejects a wrong current password (counted for lockout) and a new password outside the policy", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const { accessToken } = await login(orgA, user.employeeNumber);
    expect(await change(accessToken, { currentPassword: "errada", newPassword: "Outra-Senha-789" })).toEqual({
      status: 403,
      body: { error: "invalid_current_password" },
    });
    expect((await userRow(user.id)).failedLoginAttempts).toBe(1);
    expect(await change(accessToken, { currentPassword: DEFAULT_PASSWORD, newPassword: "curta" })).toEqual({
      status: 400,
      body: { error: "password_policy_violation" },
    });
    expect(await change(accessToken, { currentPassword: DEFAULT_PASSWORD, newPassword: "x".repeat(AUTH_SECURITY_POLICY.password.maxBytes + 1) })).toMatchObject({
      status: 400,
    });
    expect((await change(accessToken, { newPassword: "Outra-Senha-789" })).status).toBe(400);
    expect((await change(accessToken, "not-an-object")).status).toBe(400);
    await login(orgA, user.employeeNumber); // unchanged
  });

  it("locks after repeated wrong current passwords and refuses even the right one during the lock", async () => {
    const user = await seedUser(owner, orgA.tenantId);
    const { accessToken } = await login(orgA, user.employeeNumber);
    for (let i = 0; i < AUTH_SECURITY_POLICY.lockout.maxFailedAttempts; i++) {
      expect((await change(accessToken, { currentPassword: `errada-${i}`, newPassword: "Outra-Senha-789" })).status).toBe(403);
    }
    expect((await userRow(user.id)).lockedUntil).not.toBeNull();
    expect((await change(accessToken, { currentPassword: DEFAULT_PASSWORD, newPassword: "Outra-Senha-789" })).status).toBe(403);
    await expect(login(orgA, user.employeeNumber)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("with must_change_password, changing it unlocks the rest of the API for the same session", async () => {
    const user = await seedUser(owner, orgA.tenantId, { mustChangePassword: true });
    const { accessToken } = await login(orgA, user.employeeNumber);
    expect(await http.request("/pw-probe", { token: accessToken })).toEqual({ status: 403, body: { error: "password_change_required" } });
    expect((await change(accessToken, { currentPassword: DEFAULT_PASSWORD, newPassword: "Definitiva-Senha-1" })).status).toBe(204);
    expect((await http.request("/pw-probe", { token: accessToken })).status).toBe(200);
  });

  describe("administrative reset", () => {
    async function asActor<T>(org: Org, fn: () => Promise<T>): Promise<T> {
      const actor = await seedUser(owner, org.tenantId);
      return h.authContext.run({ tenantId: org.tenantId, userId: actor.id, sessionId: "0199ffff-0000-7000-8000-000000000001", deviceId: null, mustChangePassword: false }, fn);
    }

    it("sets a temporary password (hash only), forces the change, clears the lockout and revokes every session of the target", async () => {
      const target = await seedUser(owner, orgA.tenantId);
      const s1 = await login(orgA, target.employeeNumber);
      await owner.user.update({ where: { id: target.id }, data: { failedLoginAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) } });
      const temporary = "Temporaria-2026-ABC";

      await asActor(orgA, () => passwords.resetPassword(target.id, temporary));

      const row = await userRow(target.id);
      expect(row).toMatchObject({ mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null, status: UserStatus.ACTIVE });
      expect(row.passwordHash).not.toContain(temporary);
      expect((await owner.session.findUniqueOrThrow({ where: { id: s1.sessionId } })).revokedAt).not.toBeNull();
      const tokens = await login(orgA, target.employeeNumber, temporary);
      expect(tokens.mustChangePassword).toBe(true);
      const reset = await owner.auditLog.findFirstOrThrow({ where: { action: "auth.password.reset", resourceId: target.id } });
      expect(reset.userId).not.toBe(target.id); // the actor
      expect(reset.metadata).toBeNull();
    });

    it("does not unlock LOCKED or enable DISABLED users", async () => {
      for (const status of [UserStatus.LOCKED, UserStatus.DISABLED]) {
        const target = await seedUser(owner, orgA.tenantId, { status });
        await asActor(orgA, () => passwords.resetPassword(target.id, "Temporaria-2026-XYZ"));
        expect((await userRow(target.id)).status).toBe(status);
        await expect(login(orgA, target.employeeNumber, "Temporaria-2026-XYZ")).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
    });

    it("cannot reach users of another tenant; validates the temporary password", async () => {
      const foreign = await seedUser(owner, orgB.tenantId);
      const before = await userRow(foreign.id);
      await expect(asActor(orgA, () => passwords.resetPassword(foreign.id, "Temporaria-2026-ABC"))).rejects.toBeInstanceOf(UserNotFoundError);
      expect(await userRow(foreign.id)).toEqual(before);
      await expect(asActor(orgA, () => passwords.resetPassword("not-a-uuid", "Temporaria-2026-ABC"))).rejects.toBeInstanceOf(UserNotFoundError);
      const target = await seedUser(owner, orgA.tenantId);
      await expect(asActor(orgA, () => passwords.resetPassword(target.id, "curta"))).rejects.toBeInstanceOf(PasswordPolicyError);
    });
  });
});
