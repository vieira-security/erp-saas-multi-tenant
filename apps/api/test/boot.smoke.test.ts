import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { isAlive, startApi, stopChild, type ApiProcess } from "./api-process.js";

describe("API boot (child process)", () => {
  let api: ApiProcess | undefined;
  const bystanders: ReturnType<typeof spawn>[] = [];

  afterAll(async () => {
    // cleanup runs on success and failure; only processes started here are touched
    if (api) await api.stop();
    for (const b of bystanders) await stopChild(b);
  });

  it("starts, answers /health and stops only its own process", async () => {
    // an unrelated Node process that must survive the API shutdown
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    bystanders.push(bystander);
    const bystanderPid = bystander.pid as number;

    api = await startApi();
    const res = await fetch(`http://127.0.0.1:${api.port}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(api.pid).not.toBe(bystanderPid);

    await api.stop();
    expect(isAlive(api.pid)).toBe(false);
    expect(isAlive(bystanderPid)).toBe(true);
  }, 40_000);
});
