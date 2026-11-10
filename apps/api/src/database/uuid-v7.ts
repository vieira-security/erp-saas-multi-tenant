import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562) para inserts em SQL bruto, onde o `@default(uuid(7))` do Prisma Client não se aplica (o banco não tem
 * default de id; PostgreSQL 17 não tem `uuidv7()`). 48 bits de milissegundos Unix + versão 7 + variante RFC + aleatório.
 */
export function uuidV7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
