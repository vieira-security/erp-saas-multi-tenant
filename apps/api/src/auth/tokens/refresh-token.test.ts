import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveRefreshProofKey,
  formatRefreshToken,
  hashRefreshSecret,
  newRefreshSecret,
  parseRefreshToken,
  refreshHashesEqual,
} from "./refresh-token.js";

const T = "0199a000-0000-7000-8000-00000000000a";
const T2 = "0199b000-0000-7000-8000-00000000000b";
const S = "0199a000-0000-7000-8000-0000000000a2";
const authSecret = new Uint8Array(randomBytes(48));
const KEY = deriveRefreshProofKey(authSecret);

describe("refresh token codec", () => {
  it("generates 256-bit secrets and stores only their SHA-256", () => {
    const { secret, hash } = newRefreshSecret();
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(hash).toBe(`sha256$${createHash("sha256").update(secret).digest("base64url")}`);
    expect(hash).not.toContain(secret);
    const many = new Set(Array.from({ length: 1000 }, () => newRefreshSecret().secret));
    expect(many.size).toBe(1000);
  });

  it("derives a proof key distinct from the auth secret", () => {
    expect(KEY).toHaveLength(32);
    expect(Buffer.from(KEY).equals(Buffer.from(authSecret.slice(0, 32)))).toBe(false);
    expect(Buffer.from(deriveRefreshProofKey(authSecret)).equals(Buffer.from(KEY))).toBe(true);
  });

  it("round-trips tenant, session and secret when the proof is valid", () => {
    const { secret } = newRefreshSecret();
    const token = formatRefreshToken(KEY, T, S, secret);
    expect(token.split(".")).toHaveLength(5);
    expect(parseRefreshToken(KEY, token)).toEqual({ tenantId: T, sessionId: S, secret });
  });

  it("rejects tokens whose proof does not match: forged secret, swapped tenant/session, other key", () => {
    const { secret } = newRefreshSecret();
    const token = formatRefreshToken(KEY, T, S, secret);
    const [, , , , proof] = token.split(".") as [string, string, string, string, string];
    // Knowing tenantId + sessionId (not secret) is not enough to build an accepted token.
    expect(parseRefreshToken(KEY, `rt1.${T}.${S}.${newRefreshSecret().secret}.${proof}`)).toBeNull();
    expect(parseRefreshToken(KEY, `rt1.${T2}.${S}.${secret}.${proof}`)).toBeNull();
    expect(parseRefreshToken(KEY, `rt1.${T}.${T2}.${secret}.${proof}`)).toBeNull();
    expect(parseRefreshToken(KEY, `rt1.${T}.${S}.${secret}.${randomBytes(32).toString("base64url")}`)).toBeNull();
    expect(parseRefreshToken(deriveRefreshProofKey(new Uint8Array(randomBytes(48))), token)).toBeNull();
  });

  it("rejects anything outside the exact format", () => {
    const { secret } = newRefreshSecret();
    const good = formatRefreshToken(KEY, T, S, secret);
    for (const token of [
      "",
      undefined,
      42,
      good.replace(/^rt1/, "rt2"),
      `rt1.${T}.${S}.${secret}`,
      good.replace(T, T.toUpperCase()),
      `${good}x`,
      ` ${good}`,
      `${good} `,
      good.replace(S, "not-a-uuid"),
      "x".repeat(10_000),
    ]) {
      expect(parseRefreshToken(KEY, token), String(token)).toBeNull();
    }
  });

  it("compares hashes in constant time and exactly", () => {
    const a = hashRefreshSecret("a");
    expect(refreshHashesEqual(a, hashRefreshSecret("a"))).toBe(true);
    expect(refreshHashesEqual(a, hashRefreshSecret("b"))).toBe(false);
    expect(refreshHashesEqual(a, a.slice(0, -1))).toBe(false);
  });
});
