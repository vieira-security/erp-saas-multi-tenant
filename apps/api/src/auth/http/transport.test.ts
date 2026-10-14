import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTH_ENV, AuthConfigError, loadAuthConfig } from "../../config/auth-config.js";
import { UntrustedOriginError } from "../errors.js";
import { clearedRefreshCookie, readRefreshCookie, refreshCookieName, serializeRefreshCookie } from "./refresh-cookie.js";
import { assertTrustedOrigin } from "./request-origin.js";

const secret = randomBytes(48).toString("base64url");

describe("auth transport config", () => {
  it("defaults to a Secure cookie and no allowed origin outside production", () => {
    const config = loadAuthConfig({ [AUTH_ENV.secret]: secret });
    expect(config.cookieSecure).toBe(true);
    expect(config.allowedOrigins).toEqual([]);
  });

  it("allows an insecure cookie only outside production", () => {
    expect(loadAuthConfig({ [AUTH_ENV.secret]: secret, [AUTH_ENV.cookieSecure]: "false" }).cookieSecure).toBe(false);
    expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, [AUTH_ENV.cookieSecure]: "false", NODE_ENV: "production", [AUTH_ENV.allowedOrigins]: "https://a.b" })).toThrow(AuthConfigError);
    expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, [AUTH_ENV.cookieSecure]: "yes" })).toThrow(AuthConfigError);
  });

  it("requires exact https origins in production", () => {
    expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, NODE_ENV: "production" })).toThrow(AuthConfigError);
    expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, NODE_ENV: "production", [AUTH_ENV.allowedOrigins]: "http://a.b" })).toThrow(AuthConfigError);
    for (const bad of ["https://a.b/", "https://a.b/path", "*", "a.b", "https://*.a.b"]) {
      expect(() => loadAuthConfig({ [AUTH_ENV.secret]: secret, [AUTH_ENV.allowedOrigins]: bad }), bad).toThrow(AuthConfigError);
    }
    expect(loadAuthConfig({ [AUTH_ENV.secret]: secret, NODE_ENV: "production", [AUTH_ENV.allowedOrigins]: "https://a.b, https://c.d:8443" }).allowedOrigins).toEqual([
      "https://a.b",
      "https://c.d:8443",
    ]);
  });
});

describe("refresh cookie", () => {
  const secure = { cookieSecure: true };
  const insecure = { cookieSecure: false };

  it("serializes HttpOnly, SameSite=Strict, Path=/auth, Secure with the __Secure- prefix and a bounded Max-Age", () => {
    const now = new Date("2026-10-12T10:00:00Z");
    const raw = serializeRefreshCookie(secure, "rt1.x", new Date(now.getTime() + 3600_000), now);
    expect(raw).toBe("__Secure-erp_rt=rt1.x; Max-Age=3600; Expires=Mon, 12 Oct 2026 11:00:00 GMT; Path=/auth; HttpOnly; SameSite=Strict; Secure");
    expect(serializeRefreshCookie(insecure, "rt1.x", now, now)).not.toContain("Secure");
    expect(refreshCookieName(insecure)).toBe("erp_rt");
    expect(clearedRefreshCookie(secure)).toBe("__Secure-erp_rt=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/auth; HttpOnly; SameSite=Strict; Secure");
  });

  it("reads exactly one occurrence of the cookie, ignoring others", () => {
    expect(readRefreshCookie(secure, "a=1; __Secure-erp_rt=tok; b=2")).toBe("tok");
    expect(readRefreshCookie(secure, "__Secure-erp_rt=one; __Secure-erp_rt=two")).toBeNull();
    expect(readRefreshCookie(secure, "erp_rt=tok")).toBeNull();
    expect(readRefreshCookie(secure, "__Secure-erp_rt=")).toBeNull();
    expect(readRefreshCookie(secure, undefined)).toBeNull();
    expect(readRefreshCookie(secure, ["__Secure-erp_rt=tok"])).toBeNull();
  });
});

describe("origin check", () => {
  const allowed = ["https://app.example.test"];
  it("accepts the allowed origin and non-browser clients", () => {
    expect(() => assertTrustedOrigin({ origin: "https://app.example.test" }, allowed)).not.toThrow();
    expect(() => assertTrustedOrigin({}, allowed)).not.toThrow();
    expect(() => assertTrustedOrigin({ "sec-fetch-site": "same-origin" }, allowed)).not.toThrow();
  });
  it("refuses foreign, null, duplicated and cross-site requests", () => {
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "https://app.example.test.evil.example" },
      { origin: ["https://app.example.test", "https://evil.example"] },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      expect(() => assertTrustedOrigin(headers, allowed), JSON.stringify(headers)).toThrow(UntrustedOriginError);
    }
  });
});
