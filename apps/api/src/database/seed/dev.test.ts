import { describe, expect, it } from "vitest";
import { normalizeEmployeeNumber } from "../../users/employee-number.js";
import { checkBranchCode } from "../../organization/validation/branch-code.js";
import { checkCnpj } from "../../organization/validation/cnpj.js";
import { optionGroup } from "../../products/validation.js";
import { DEFAULT_ROLES } from "../../tenants/default-roles.js";
import { normalizeLoginCode } from "../../tenants/login-code.js";
import {
  DEMO_BRANCHES,
  DEMO_BRANCH_SETTINGS,
  DEMO_COMPANY,
  DEMO_PRODUCTS,
  DEMO_TENANT,
  DEMO_USERS,
  DevSeedRefusedError,
  devSeedOptions,
} from "./dev.js";

const OK_ENV = { ALLOW_DEV_SEED: "true", DEV_SEED_PASSWORD: "Uma-Senha-Local-1" };

describe("devSeedOptions (refuses unsafe environments)", () => {
  it("accepts a development environment with ALLOW_DEV_SEED=true and a password", () => {
    expect(devSeedOptions({ ...OK_ENV })).toEqual({ password: OK_ENV.DEV_SEED_PASSWORD });
    expect(devSeedOptions({ ...OK_ENV, NODE_ENV: "development" })).toEqual({ password: OK_ENV.DEV_SEED_PASSWORD });
  });

  it("refuses NODE_ENV=production even with everything else set", () => {
    expect(() => devSeedOptions({ ...OK_ENV, NODE_ENV: "production" })).toThrow(DevSeedRefusedError);
  });

  it("refuses unless ALLOW_DEV_SEED is exactly 'true'", () => {
    for (const allow of [undefined, "", "1", "TRUE", "yes", " true"]) {
      const env: NodeJS.ProcessEnv = { DEV_SEED_PASSWORD: OK_ENV.DEV_SEED_PASSWORD };
      if (allow !== undefined) env["ALLOW_DEV_SEED"] = allow;
      expect(() => devSeedOptions(env), String(allow)).toThrow(/ALLOW_DEV_SEED/);
    }
  });

  it("refuses without DEV_SEED_PASSWORD or with one outside the password policy, never echoing it", () => {
    expect(() => devSeedOptions({ ALLOW_DEV_SEED: "true" })).toThrow(/DEV_SEED_PASSWORD is not set/);
    expect(() => devSeedOptions({ ALLOW_DEV_SEED: "true", DEV_SEED_PASSWORD: "" })).toThrow(/DEV_SEED_PASSWORD is not set/);
    try {
      devSeedOptions({ ALLOW_DEV_SEED: "true", DEV_SEED_PASSWORD: "curta" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DevSeedRefusedError);
      expect((error as Error).message).toMatch(/password policy/);
      expect((error as Error).message).not.toContain("curta");
    }
  });
});

describe("demo data satisfies the domain rules", () => {
  it("uses valid public identifiers", () => {
    expect(normalizeLoginCode(DEMO_TENANT.loginCode)).toBe("DEMO");
    expect(checkCnpj(DEMO_COMPANY.cnpj)).toEqual({ ok: true, value: DEMO_COMPANY.cnpj });
    for (const b of DEMO_BRANCHES) expect(checkBranchCode(b.code), b.code).toEqual({ ok: true, value: b.code });
    for (const p of DEMO_PRODUCTS) expect(checkBranchCode(p.code), p.code).toEqual({ ok: true, value: p.code }); // same format as Product.code
    for (const u of DEMO_USERS) expect(normalizeEmployeeNumber(u.employeeNumber), u.employeeNumber).toBe(u.employeeNumber);
  });

  it("references only default roles, demo branches and demo products", () => {
    const roles = DEFAULT_ROLES.map((r) => r.code as string);
    const branches = DEMO_BRANCHES.map((b) => b.code as string);
    const products = DEMO_PRODUCTS.map((p) => p.code);
    expect(new Set(products).size).toBe(products.length);
    for (const u of DEMO_USERS) {
      expect(roles).toContain(u.role);
      for (const b of u.branches) expect(branches).toContain(b);
    }
    for (const s of DEMO_BRANCH_SETTINGS) {
      expect(branches).toContain(s.branch);
      expect(products).toContain(s.product);
    }
  });

  it("has the option groups the frontend needs (variation, add-ons, combo) and they pass the HTTP parser", () => {
    const uuid = "0199a000-0000-7000-8000-00000000000a";
    for (const p of DEMO_PRODUCTS) {
      for (const g of p.optionGroups ?? []) {
        const raw = { ...g, options: g.options.map(({ linkedProductCode, ...o }) => (linkedProductCode ? { ...o, linkedProductId: uuid } : o)) };
        expect(optionGroup(raw).ok, `${p.code}/${g.name}`).toBe(true);
        for (const o of g.options) {
          // A combo links an earlier product that has no groups of its own.
          if (!o.linkedProductCode) continue;
          const linked = DEMO_PRODUCTS.findIndex((x) => x.code === o.linkedProductCode);
          expect(linked).toBeGreaterThanOrEqual(0);
          expect(linked).toBeLessThan(DEMO_PRODUCTS.indexOf(p));
          expect(DEMO_PRODUCTS[linked]!.optionGroups ?? []).toEqual([]);
        }
      }
    }
    const groups = DEMO_PRODUCTS.flatMap((p) => p.optionGroups ?? []);
    expect(groups.some((g) => g.minChoices === 1 && g.maxChoices === 1 && !g.options.some((o) => o.linkedProductCode))).toBe(true);
    expect(groups.some((g) => g.minChoices === 0 && g.maxChoices === 3)).toBe(true);
    expect(groups.some((g) => g.options.every((o) => o.linkedProductCode))).toBe(true);
    expect(DEMO_PRODUCTS.some((p) => p.status === "INACTIVE")).toBe(true);
  });
});
