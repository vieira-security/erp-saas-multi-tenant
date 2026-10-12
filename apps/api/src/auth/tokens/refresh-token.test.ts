import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatRefreshToken, hashRefreshSecret, newRefreshSecret, parseRefreshToken, refreshHashesEqual } from "./refresh-token.js";

const T = "0199a000-0000-7000-8000-00000000000a";
const S = "0199a000-0000-7000-8000-0000000000a2";

describe("refresh token codec", () => {
  it("generates 256-bit secrets and stores only their SHA-256", () => {
    const { secret, hash } = newRefreshSecret();
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(hash).toBe(`sha256$${createHash("sha256").update(secret).digest("base64url")}`);
    expect(hash).not.toContain(secret);
    const many = new Set(Array.from({ length: 1000 }, () => newRefreshSecret().secret));
    expect(many.size).toBe(1000);
  });

  it("round-trips tenant, session and secret", () => {
    const { secret } = newRefreshSecret();
    const token = formatRefreshToken(T, S, secret);
    expect(token).toMatch(/^rt1\./);
    expect(parseRefreshToken(token)).toEqual({ tenantId: T, sessionId: S, secret });
  });

  it("rejects anything outside the exact format", () => {
    const { secret } = newRefreshSecret();
    for (const token of [
      "",
      undefined,
      42,
      `rt2.${T}.${S}.${secret}`,
      `rt1.${T}.${S}`,
      `rt1.${T.toUpperCase()}.${S}.${secret}`,
      `rt1.${T}.${S}.${secret}x`,
      `rt1.${T}.${S}.${secret.slice(1)}`,
      `rt1.${T}.${S}.${secret} `,
      ` rt1.${T}.${S}.${secret}`,
      `rt1.${T}.not-a-uuid.${secret}`,
      `rt1.${T}.${S}.${secret.slice(0, 42)}+`,
      "x".repeat(10_000),
    ]) {
      expect(parseRefreshToken(token), String(token)).toBeNull();
    }
  });

  it("compares hashes in constant time and exactly", () => {
    const a = hashRefreshSecret("a");
    expect(refreshHashesEqual(a, hashRefreshSecret("a"))).toBe(true);
    expect(refreshHashesEqual(a, hashRefreshSecret("b"))).toBe(false);
    expect(refreshHashesEqual(a, a.slice(0, -1))).toBe(false);
  });
});
