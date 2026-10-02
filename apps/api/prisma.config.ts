import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Somente via ambiente; opcional para que `prisma generate`/`validate` rodem sem banco.
  datasource: process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {},
});
