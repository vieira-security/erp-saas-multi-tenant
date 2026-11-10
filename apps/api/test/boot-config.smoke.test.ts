import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bootEnv } from "./api-process.js";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** Runs the built API with `env` and returns its exit code (it must exit on its own: fail-fast config). */
function exitCodeOf(env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...env, PORT: "0" }, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("API did not fail fast"));
    }, 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("API boot configuration (child process)", () => {
  it("refuses to start without an access token secret, with a weak one, or without DATABASE_URL", async () => {
    for (const env of [
      bootEnv({ AUTH_ACCESS_TOKEN_SECRET: undefined }),
      bootEnv({ AUTH_ACCESS_TOKEN_SECRET: "short" }),
      bootEnv({ AUTH_ACCESS_TOKEN_SECRET: "change-me-change-me-change-me-change-me" }),
      bootEnv({ NODE_ENV: "production", AUTH_ACCESS_TOKEN_SECRET: undefined }),
      bootEnv({ DATABASE_URL: undefined }),
    ]) {
      expect(await exitCodeOf(env)).not.toBe(0);
    }
  }, 90_000);
});
