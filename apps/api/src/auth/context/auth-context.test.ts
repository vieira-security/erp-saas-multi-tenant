import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { TenantContextService } from "../../tenancy/tenant-context.js";
import { AuthContextMissingError, AuthContextService, AuthTenantMismatchError, type AuthContext } from "./auth-context.js";

const A = "0199a000-0000-7000-8000-00000000000a";
const B = "0199b000-0000-7000-8000-00000000000b";
const auth = (tenantId: string, userId = "u"): AuthContext => ({ tenantId, userId, sessionId: "s", deviceId: null, mustChangePassword: false });

describe("AuthContextService", () => {
  const tenants = new TenantContextService();
  const service = new AuthContextService(tenants);

  it("opens the tenant context together with the auth context, frozen", () => {
    const seen = service.run(auth(A.toUpperCase()), () => [service.require(), tenants.requireTenantId()] as const);
    expect(seen[0]).toEqual(auth(A));
    expect(seen[1]).toBe(A);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("fails outside run() and leaves nothing behind", async () => {
    expect(() => service.require()).toThrow(AuthContextMissingError);
    await service.run(auth(A), () => sleep(1));
    expect(service.current()).toBeUndefined();
    expect(tenants.current()).toBeUndefined();
  });

  it("detects a nested tenant run() that diverges from the authenticated tenant", () => {
    service.run(auth(A), () => {
      expect(() => tenants.run({ tenantId: B }, () => service.require())).toThrow(AuthTenantMismatchError);
      expect(service.require().tenantId).toBe(A);
    });
  });

  it("never mixes concurrent identities", async () => {
    const observe = (ctx: AuthContext) =>
      service.run(ctx, async () => {
        const seen: string[] = [];
        for (const ms of [3, 1, 4]) {
          await sleep(ms);
          seen.push(`${service.require().userId}@${tenants.requireTenantId()}`);
        }
        return seen;
      });
    const [a, b] = await Promise.all([observe(auth(A, "ua")), observe(auth(B, "ub"))]);
    expect(a).toEqual(Array(3).fill(`ua@${A}`));
    expect(b).toEqual(Array(3).fill(`ub@${B}`));
  });
});
