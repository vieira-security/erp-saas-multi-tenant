import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createPrismaClient } from "./create-prisma-client.js";

/** Token do PrismaClient da aplicação (runtime: `DATABASE_URL` de `erp_app`). */
export const PRISMA_CLIENT = Symbol("PRISMA_CLIENT");

export class DatabaseConfigError extends Error {
  override readonly name = "DatabaseConfigError";
}

/** Cria o client a partir de `DATABASE_URL`; falha no boot sem ela. A conexão é aberta sob demanda (adapter-pg). */
export function prismaClientFromEnv(env: NodeJS.ProcessEnv = process.env): PrismaClient {
  const url = env["DATABASE_URL"];
  if (!url) throw new DatabaseConfigError("DATABASE_URL is not set");
  return createPrismaClient(url);
}

class PrismaLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Provider Nest do PrismaClient (M2). Código de negócio não usa o client direto: constrói repositories com TenantScope
 * (`new XRepository(prisma | tx, scope)`), como em docs/architecture.md.
 */
@Global()
@Module({
  providers: [{ provide: PRISMA_CLIENT, useFactory: () => prismaClientFromEnv() }, PrismaLifecycle],
  exports: [PRISMA_CLIENT],
})
export class DatabaseModule {}
