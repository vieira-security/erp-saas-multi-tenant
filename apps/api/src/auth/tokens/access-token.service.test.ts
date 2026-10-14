import { randomBytes } from "node:crypto";
import { SignJWT, UnsecuredJWT, base64url } from "jose";
import { describe, expect, it } from "vitest";
import { AUTH_ENV, loadAuthConfig } from "../../config/auth-config.js";
import { UnauthenticatedError } from "../errors.js";
import { AccessTokenService, type AccessTokenSubject } from "./access-token.service.js";

const config = loadAuthConfig({ [AUTH_ENV.secret]: randomBytes(48).toString("base64url") });
const service = new AccessTokenService(config);

const subject: AccessTokenSubject = {
  tenantId: "0199a000-0000-7000-8000-00000000000a",
  userId: "0199a000-0000-7000-8000-0000000000a1",
  sessionId: "0199a000-0000-7000-8000-0000000000a2",
  deviceId: null,
};

async function rejects(token: string, now?: Date): Promise<void> {
  await expect(service.verify(token, now)).rejects.toBeInstanceOf(UnauthenticatedError);
}

/** Replaces the payload of a signed JWT, keeping header and signature (classic claim tampering). */
function withPayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const decoded = JSON.parse(new TextDecoder().decode(base64url.decode(payload))) as Record<string, unknown>;
  mutate(decoded);
  return [header, base64url.encode(JSON.stringify(decoded)), signature].join(".");
}

describe("AccessTokenService", () => {
  it("issues a short-lived token with minimal claims and verifies it", async () => {
    const issued = await service.issue({ ...subject, deviceId: "0199a000-0000-7000-8000-0000000000a3" });
    const verified = await service.verify(issued.token);
    expect(verified).toMatchObject({ ...subject, deviceId: "0199a000-0000-7000-8000-0000000000a3", tokenId: issued.tokenId });
    expect(verified.expiresAt.getTime() - verified.issuedAt.getTime()).toBe(config.accessTokenTtlSeconds * 1000);

    const [header, payload] = issued.token.split(".") as [string, string];
    expect(JSON.parse(new TextDecoder().decode(base64url.decode(header)))).toEqual({ alg: "HS256", typ: "at+jwt" });
    expect(Object.keys(JSON.parse(new TextDecoder().decode(base64url.decode(payload)))).sort()).toEqual(
      ["aud", "did", "exp", "iat", "iss", "jti", "sid", "sub", "tid"],
    );
  });

  it("omits did when the session has no device and uses a fresh jti every time", async () => {
    const [a, b] = await Promise.all([service.issue(subject), service.issue(subject)]);
    expect((await service.verify(a.token)).deviceId).toBeNull();
    expect(a.tokenId).not.toBe(b.tokenId);
  });

  it("rejects tampered claims (tenant, user, session) because the signature no longer matches", async () => {
    const { token } = await service.issue(subject);
    await rejects(withPayload(token, (p) => (p["tid"] = "0199b000-0000-7000-8000-00000000000b")));
    await rejects(withPayload(token, (p) => (p["sub"] = "0199b000-0000-7000-8000-0000000000b1")));
    await rejects(withPayload(token, (p) => (p["sid"] = "0199b000-0000-7000-8000-0000000000b2")));
    await rejects(withPayload(token, (p) => (p["exp"] = Number(p["exp"]) + 3600)));
    await rejects(token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA"));
  });

  it("rejects alg=none and every algorithm other than HS256", async () => {
    const unsecured = new UnsecuredJWT({ tid: subject.tenantId, sid: subject.sessionId })
      .setSubject(subject.userId)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("x")
      .encode();
    await rejects(unsecured);
    for (const alg of ["HS384", "HS512"]) {
      const token = await new SignJWT({ tid: subject.tenantId, sid: subject.sessionId })
        .setProtectedHeader({ alg, typ: "at+jwt" })
        .setSubject(subject.userId)
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .setJti("x")
        .sign(config.accessTokenSecret);
      await rejects(token);
    }
  });

  it("rejects a token signed with another key, of another type, issuer or audience", async () => {
    const other = new AccessTokenService(loadAuthConfig({ [AUTH_ENV.secret]: randomBytes(48).toString("base64url") }));
    await rejects((await other.issue(subject)).token);

    const sign = (header: { typ?: string }, iss = config.issuer, aud = config.audience) =>
      new SignJWT({ tid: subject.tenantId, sid: subject.sessionId })
        .setProtectedHeader({ alg: "HS256", ...header })
        .setSubject(subject.userId)
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("5m")
        .setJti("x")
        .sign(config.accessTokenSecret);
    await rejects(await sign({ typ: "JWT" }));
    await rejects(await sign({}));
    await rejects(await sign({ typ: "at+jwt" }, "someone-else"));
    await rejects(await sign({ typ: "at+jwt" }, config.issuer, "another-api"));
  });

  it("rejects expired tokens and tokens with invalid claim formats", async () => {
    const past = new Date(Date.now() - 2 * config.accessTokenTtlSeconds * 1000);
    await rejects((await service.issue(subject, past)).token);
    await rejects((await service.issue({ ...subject, tenantId: "not-a-uuid" })).token);
    await rejects((await service.issue({ ...subject, userId: subject.userId.toUpperCase() })).token);
  });

  it("rejects garbage without leaking details", async () => {
    for (const token of ["", "abc", "a.b.c", "x".repeat(5000), undefined as never]) await rejects(token);
    const error = (await service.verify("a.b.c").catch((e: unknown) => e)) as Error;
    expect(error?.message).not.toContain("a.b.c");
  });
});
