import "reflect-metadata";
import { createPrismaClient } from "./create-prisma-client.js";
import { DevSeedRefusedError, devSeedOptions, seedDevData } from "./seed/dev.js";

// Entrada do seed de DESENVOLVIMENTO (`npm run db:seed:dev`). Ver src/database/seed/dev.ts e infrastructure/postgres/README.md.
// Usa a DATABASE_URL do ambiente, que deve ser a de erp_migrator (a mesma do `db:seed`), nunca a de erp_app.
let options: { password: string };
try {
  options = devSeedOptions();
} catch (error) {
  if (!(error instanceof DevSeedRefusedError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (use the erp_migrator connection, as for `npm run db:seed`)");

const prisma = createPrismaClient(url);
try {
  const summary = await seedDevData(prisma, options);
  const created = Object.entries(summary.created)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  console.log(`Development seed ${summary.tenantCreated ? "created" : "completed"} tenant DEMO; created: ${created}`);
} finally {
  await prisma.$disconnect();
}
