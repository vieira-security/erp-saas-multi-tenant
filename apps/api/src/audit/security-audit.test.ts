import { describe, expect, it } from "vitest";
import { TenantContextService } from "../tenancy/tenant-context.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { SecurityAuditWriter, UnsafeAuditMetadataError, assertSafeAuditMetadata, normalizeIp, type SecurityAuditEvent } from "./security-audit.js";

const T = "0199a000-0000-7000-8000-00000000000a";
const U = "0199a000-0000-7000-8000-0000000000a1";
const S = "0199a000-0000-7000-8000-0000000000a2";

/** Captures what would be inserted, without a database. */
function writer() {
  const rows: Record<string, unknown>[] = [];
  const tenants = new TenantContextService();
  const db = { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void rows.push(data) } };
  const audit = new SecurityAuditWriter(db as never, new TenantScope(tenants));
  return { rows, record: (event: SecurityAuditEvent, ip?: string) => tenants.run({ tenantId: T }, () => audit.record(event, { ipAddress: ip ?? null })) };
}

const SENSITIVE = [
  "password",
  "newPassword",
  "currentPassword",
  "temporaryPassword",
  "passwordHash",
  "accessToken",
  "refreshToken",
  "refreshTokenHash",
  "authorization",
  "cookie",
  "employeeNumber",
  "secret",
];

describe("security audit metadata", () => {
  it("accepts only the allowlisted keys with simple values", () => {
    expect(() => assertSafeAuditMetadata({ reason: "invalid_credentials", count: 2, locked_until: new Date().toISOString() })).not.toThrow();
    for (const key of [...SENSITIVE, "target_user_id", "session_id", "__proto__x", "Reason"]) {
      expect(() => assertSafeAuditMetadata({ [key]: "x" }), key).toThrow(UnsafeAuditMetadataError);
    }
  });

  it("rejects non-scalar, oversized, negative or free-text values even under an allowed key", () => {
    for (const value of [{ password: "x" }, ["x"], "a".repeat(65), "has space", "quote\"", -1, 1.5, null, true]) {
      expect(() => assertSafeAuditMetadata({ reason: value }), JSON.stringify(value)).toThrow(UnsafeAuditMetadataError);
    }
    expect(() => assertSafeAuditMetadata(null as never)).toThrow(UnsafeAuditMetadataError);
    expect(() => assertSafeAuditMetadata([] as never)).toThrow(UnsafeAuditMetadataError);
  });

  it("never copies extra (smuggled) fields of an event into the row", async () => {
    const { rows, record } = writer();
    const smuggled = Object.fromEntries(SENSITIVE.map((k) => [k, `leak-${k}`]));
    const events = [
      { action: "auth.login.succeeded", userId: U, sessionId: S, deviceId: null },
      { action: "auth.login.failed", userId: null, deviceId: null, reason: "invalid_credentials" },
      { action: "auth.password.change_failed", userId: U, deviceId: null },
      { action: "auth.lockout.triggered", userId: U, lockedUntil: new Date() },
      { action: "auth.session.revoked", sessionId: S, actorUserId: U, reason: "logout" },
      { action: "auth.sessions.revoked", userId: U, actorUserId: null, reason: "password_reset", count: 3 },
      { action: "auth.refresh.replay_detected", sessionId: S, userId: U, deviceId: null },
      { action: "auth.password.changed", userId: U },
      { action: "auth.password.reset", targetUserId: U, actorUserId: U },
    ] as const;
    for (const event of events) await record({ ...event, ...smuggled } as never);
    expect(rows).toHaveLength(events.length);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("leak-");
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["action", "deviceId", "ipAddress", "resourceId", "resourceType", "tenantId", "userId", ...("metadata" in row ? ["metadata"] : [])].sort(),
      );
      expect(row["tenantId"]).toBe(T);
    }
  });

  it("refuses a value that would break the allowlist even if a future event built it from input", async () => {
    const { record } = writer();
    await expect(record({ action: "auth.login.failed", userId: null, deviceId: null, reason: "Senha123 digitada" as never })).rejects.toThrow(
      UnsafeAuditMetadataError,
    );
  });

  it("stores only valid IPs", () => {
    expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("::1")).toBe("::1");
    for (const ip of ["", "not-an-ip", "10.0.0.1, 10.0.0.2", undefined, null]) expect(normalizeIp(ip)).toBeNull();
  });
});
