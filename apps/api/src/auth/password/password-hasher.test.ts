import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { AUTH_SECURITY_POLICY } from "../auth-security-policy.js";
import { ARGON2ID_PARAMS, InvalidPasswordHashError, PasswordHasher, PasswordInputRejectedError } from "./password-hasher.js";

describe("PasswordHasher (Argon2id)", () => {
  const hasher = new PasswordHasher();

  it("produces a self-contained Argon2id hash with the central parameters", async () => {
    const hash = await hasher.hash("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(hash).not.toContain("correct horse");
  });

  it("salts every hash: the same password never yields the same hash", async () => {
    const [a, b] = await Promise.all([hasher.hash("same-password"), hasher.hash("same-password")]);
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, "same-password")).toBe(true);
    expect(await hasher.verify(b, "same-password")).toBe(true);
  });

  it("verifies the right password and rejects wrong ones", async () => {
    const hash = await hasher.hash("s3cret-Pass");
    expect(await hasher.verify(hash, "s3cret-Pass")).toBe(true);
    for (const wrong of ["s3cret-pass", "s3cret-Pass ", "", "S3CRET-PASS", "s3cret-Pas"]) {
      expect(await hasher.verify(hash, wrong), JSON.stringify(wrong)).toBe(false);
    }
  });

  it("handles non-ASCII passwords byte-exactly", async () => {
    const hash = await hasher.hash("pão-de-queijo ☕");
    expect(await hasher.verify(hash, "pão-de-queijo ☕")).toBe(true);
    expect(await hasher.verify(hash, "pao-de-queijo ☕")).toBe(false);
  });

  it("rejects absurdly large or empty input before hashing (DoS bound)", async () => {
    const max = AUTH_SECURITY_POLICY.password.maxBytes;
    await expect(hasher.hash("a".repeat(max + 1))).rejects.toThrow(PasswordInputRejectedError);
    // Multi-byte characters count in bytes, not code units.
    await expect(hasher.hash("é".repeat(max / 2 + 1))).rejects.toThrow(PasswordInputRejectedError);
    await expect(hasher.hash("")).rejects.toThrow(PasswordInputRejectedError);
    await expect(hasher.hash(undefined as never)).rejects.toThrow(PasswordInputRejectedError);
    expect(await hasher.hash("a".repeat(max))).toMatch(/^\$argon2id\$/);

    const hash = await hasher.hash("short");
    const started = performance.now();
    expect(await hasher.verify(hash, "x".repeat(10 * 1024 * 1024))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("never echoes the password in errors", async () => {
    const error = await hasher.hash("p".repeat(5000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasswordInputRejectedError);
    expect(String((error as Error).message)).not.toContain("ppp");
  });

  it("raises a safe error for malformed or non-Argon2id stored hashes", async () => {
    const argon2i = await argon2.hash("pw", { ...ARGON2ID_PARAMS, type: argon2.argon2i });
    const bad = ["", "plain-text", "$2b$10$abcdefghijklmnopqrstuuJ6.oP2X7u8sW9OBnGqKnFhLwV8C1Wq", argon2i, "$argon2id$v=19$m=19456,t=2,p=1$broken"];
    for (const stored of bad) {
      const error = await hasher.verify(stored, "pw").catch((e: unknown) => e);
      expect(error, stored).toBeInstanceOf(InvalidPasswordHashError);
      expect((error as Error).message).not.toContain(stored || "\u0000");
    }
  });

  it("flags hashes made with other parameters for rehash", async () => {
    const weaker = await argon2.hash("pw", { ...ARGON2ID_PARAMS, memoryCost: 8192 });
    expect(hasher.needsRehash(weaker)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash("pw"))).toBe(false);
    expect(hasher.needsRehash("garbage")).toBe(true);
  });

  it("burns a real verification for timing equalization without throwing", async () => {
    await expect(hasher.burnVerification("anything")).resolves.toBeUndefined();
    await expect(hasher.burnVerification("x".repeat(100_000))).resolves.toBeUndefined();
  });
});
