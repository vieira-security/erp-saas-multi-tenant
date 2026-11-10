import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * Única forma de criar um PrismaClient na api.
 *
 * O `@prisma/adapter-pg` envia `DateTime` sem offset (hora UTC) e descarta o offset ao ler,
 * ou seja, presume sessão em UTC. Fixar `TimeZone=UTC` na conexão garante que `timestamptz`
 * guarde o instante correto mesmo se o servidor/banco tiver outro fuso padrão.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString, options: "-c TimeZone=UTC" });
  return new PrismaClient({ adapter });
}
