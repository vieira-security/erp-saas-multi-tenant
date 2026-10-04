import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  // Seed compilado pelo nest build (sem tsx); idempotente, ver src/database/seed/.
  migrations: { path: "prisma/migrations", seed: "npm run db:seed" },
  // Somente via ambiente; opcional para que `prisma generate`/`validate` rodem sem banco.
  datasource: process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {},
});
