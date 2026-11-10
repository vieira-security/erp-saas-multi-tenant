import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTH_ENV,
  AuthConfigError,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  loadAuthConfig,
} from "./auth-config.js";

const strong = () => randomBytes(48).toString("base64url");

describe("loadAuthConfig", () => {
  it("loads a strong secret with the default TTLs", () => {
    const config = loadAuthConfig({ [AUTH_ENV.secret]: strong() });
    expect(config.accessTokenSecret.byteLength).toBeGreaterThanOrEqual(32);
    expect(config.accessTokenTtlSeconds).toBe(DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
    expect(config.refreshTokenTtlSeconds).toBe(DEFAULT_REFRESH_TOKEN_TTL_SECONDS);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("fails fast without a secret, in any environment", () => {
    for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "development" }, { [AUTH_ENV.secret]: "" }]) {
      expect(() => loadAuthConfig(env)).toThrow(AuthConfigError);
    }
  });

  it("rejects short, repetitive and placeholder secrets", () => {
    for (const secret of ["short", "a".repeat(64), "change-me-change-me-change-me-change-me", "replace_me_with_a_real_secret_value_0123456789", "ab".repeat(40)]) {
      expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret }), secret).toThrow(AuthConfigError);
    }
  });

  it("never echoes the secret in its errors", () => {
    const secret = "change-me-" + strong();
    const error = (() => {
      try {
        loadAuthConfig({ [AUTH_ENV.secret]: secret });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(AuthConfigError);
    expect(error?.message).not.toContain(secret);
  });

  it("validates TTLs (integers, bounds, refresh longer than access)", () => {
    const secret = strong();
    expect(loadAuthConfig({ [AUTH_ENV.secret]: secret, [AUTH_ENV.accessTtl]: "300", [AUTH_ENV.refreshTtl]: "3600" })).toMatchObject({
      accessTokenTtlSeconds: 300,
      refreshTokenTtlSeconds: 3600,
    });
    for (const [name, value] of [
      [AUTH_ENV.accessTtl, "abc"],
      [AUTH_ENV.accessTtl, "-5"],
      [AUTH_ENV.accessTtl, "1.5"],
      [AUTH_ENV.accessTtl, "10"],
      [AUTH_ENV.accessTtl, "86400"],
      [AUTH_ENV.refreshTtl, "60"],
      [AUTH_ENV.refreshTtl, String(365 * 24 * 3600)],
    ] as const) {
      expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, [name]: value }), `${name}=${value}`).toThrow(AuthConfigError);
    }
    expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, [AUTH_ENV.accessTtl]: "900", [AUTH_ENV.refreshTtl]: "600" })).toThrow(
      AuthConfigError,
    );
  });
});
