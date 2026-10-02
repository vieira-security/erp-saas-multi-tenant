import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

export interface ApiProcess {
  child: ChildProcess;
  pid: number;
  port: number;
  stop: () => Promise<void>;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Stops exactly the given child (by reference/PID); never touches other processes. */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check timed out after ${timeoutMs}ms`);
}

export async function startApi(timeoutMs = 20_000): Promise<ApiProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("failed to spawn API process");
  try {
    await waitForHealth(port, child, timeoutMs);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { child, pid: child.pid, port, stop: () => stopChild(child) };
}
