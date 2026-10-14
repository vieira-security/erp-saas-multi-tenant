import { setTimeout as sleep } from "node:timers/promises";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { InvalidTenantIdError, TenantContextMissingError, TenantContextService } from "./tenant-context.js";
import { TenancyModule } from "./tenancy.module.js";

const A = "0199a000-0000-7000-8000-00000000000a";
const B = "0199b000-0000-7000-8000-00000000000b";

describe("TenantContextService", () => {
  const tenants = new TenantContextService();

  it("exposes the tenant inside run() (1. simple context)", () => {
    const seen = tenants.run({ tenantId: A }, () => [tenants.requireTenantId(), tenants.requireContext(), tenants.current()]);
    expect(seen).toEqual([A, { tenantId: A }, { tenantId: A }]);
  });

  it("fails clearly without a context, with no fallback tenant (2. missing context)", () => {
    expect(tenants.current()).toBeUndefined();
    expect(() => tenants.requireTenantId()).toThrow(TenantContextMissingError);
    expect(() => tenants.requireContext()).toThrow(TenantContextMissingError);
  });

  it("rejects a tenant id that is not a UUID when the context is created", () => {
    for (const tenantId of ["", "tenant-a", `${A} `, `${A}0`, "../etc", " ".repeat(36)]) {
      expect(() => tenants.run({ tenantId }, () => undefined), JSON.stringify(tenantId)).toThrow(InvalidTenantIdError);
    }
    expect(() => tenants.run(undefined as never, () => undefined)).toThrow(InvalidTenantIdError);
    expect(() => tenants.run({ tenantId: 42 } as never, () => undefined)).toThrow(InvalidTenantIdError);
  });

  it("normalizes the UUID to lower case", () => {
    expect(tenants.run({ tenantId: A.toUpperCase() }, () => tenants.requireTenantId())).toBe(A);
  });

  it("keeps only the known fields, frozen", () => {
    const context = tenants.run({ tenantId: A, userId: "x" } as never, () => tenants.requireContext());
    expect(context).toEqual({ tenantId: A });
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { tenantId: string }).tenantId = B;
    }).toThrow(TypeError);
  });

  it("survives awaits and timers (4. after await)", async () => {
    const seen = await tenants.run({ tenantId: A }, async () => {
      const before = tenants.requireTenantId();
      await sleep(5);
      const afterTimer = tenants.requireTenantId();
      await Promise.resolve();
      return [before, afterTimer, tenants.requireTenantId()];
    });
    expect(seen).toEqual([A, A, A]);
  });

  it("keeps the tenant inside every branch of Promise.all (5. Promise.all)", async () => {
    const seen = await tenants.run({ tenantId: A }, () =>
      Promise.all([1, 2, 3].map(async (ms) => {
        await sleep(ms);
        return tenants.requireTenantId();
      })),
    );
    expect(seen).toEqual([A, A, A]);
  });

  it("never mixes two concurrent contexts (3. parallel A/B)", async () => {
    const observe = (tenantId: string, delays: number[]) =>
      tenants.run({ tenantId }, async () => {
        const seen: string[] = [];
        for (const ms of delays) {
          await sleep(ms);
          seen.push(tenants.requireTenantId());
        }
        return seen;
      });

    // Interleaved delays force A and B to resume alternately on the same event loop.
    const [a, b] = await Promise.all([observe(A, [3, 1, 4, 1, 5]), observe(B, [1, 4, 1, 5, 2])]);
    expect(a).toEqual([A, A, A, A, A]);
    expect(b).toEqual([B, B, B, B, B]);
    expect(tenants.current()).toBeUndefined();
  });

  it("isolates many concurrent contexts", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `0199c000-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const seen = await Promise.all(
      ids.map((tenantId, i) =>
        tenants.run({ tenantId }, async () => {
          await sleep((i * 7) % 5);
          return tenants.requireTenantId();
        }),
      ),
    );
    expect(seen).toEqual(ids);
  });

  it("lets a nested run() replace the context and restores the outer one afterwards (6. nested)", async () => {
    const seen = await tenants.run({ tenantId: A }, async () => {
      const inner = await tenants.run({ tenantId: B }, async () => {
        await sleep(1);
        return tenants.requireTenantId();
      });
      const syncInner = tenants.run({ tenantId: B }, () => tenants.requireTenantId());
      await sleep(1);
      return { outerBefore: A, inner, syncInner, outerAfter: tenants.requireTenantId() };
    });
    expect(seen).toEqual({ outerBefore: A, inner: B, syncInner: B, outerAfter: A });
  });

  it("restores the outer context when a nested run() throws", () => {
    const outerAfter = tenants.run({ tenantId: A }, () => {
      expect(() =>
        tenants.run({ tenantId: B }, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      return tenants.requireTenantId();
    });
    expect(outerAfter).toBe(A);
  });

  it("leaves no residual context after run() returns, resolves or throws (13. no leak)", async () => {
    tenants.run({ tenantId: A }, () => undefined);
    expect(tenants.current()).toBeUndefined();

    await tenants.run({ tenantId: A }, async () => sleep(1));
    expect(tenants.current()).toBeUndefined();

    await expect(
      tenants.run({ tenantId: A }, async () => {
        await sleep(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(tenants.current()).toBeUndefined();
    expect(() => tenants.requireTenantId()).toThrow(TenantContextMissingError);
  });

  it("shares one context across service instances (no per-instance tenant state)", () => {
    const other = new TenantContextService();
    expect(tenants.run({ tenantId: A }, () => other.requireTenantId())).toBe(A);
  });

  it("is provided globally by TenancyModule", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TenancyModule] }).compile();
    const service = moduleRef.get(TenantContextService);
    expect(service.run({ tenantId: B }, () => service.requireTenantId())).toBe(B);
    await moduleRef.close();
  });
});
