import type { AddressInfo } from "node:net";
import type { INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { AUTH_CONFIG, type AuthConfig } from "../../src/config/auth-config.js";
import { PRISMA_CLIENT } from "../../src/database/database.module.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

export interface HttpApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  request(path: string, init?: { method?: string; token?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/**
 * The real AppModule (global AuthGuard, interceptor, filter, PermissionGuard) listening on a random local port, with the
 * runtime PrismaClient (erp_app) and a test AuthConfig injected instead of the environment.
 */
export async function startHttpApp(prisma: PrismaClient, config: AuthConfig, controllers: Type[] = [], providers: Type[] = []): Promise<HttpApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers, providers })
    .overrideProvider(PRISMA_CLIENT)
    .useValue(prisma)
    .overrideProvider(AUTH_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    baseUrl,
    async request(path, init = {}) {
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (init.token) headers["authorization"] = `Bearer ${init.token}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(baseUrl + path, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    close: () => app.close(),
  };
}
