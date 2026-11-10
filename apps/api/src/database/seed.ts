import { createPrismaClient } from "./create-prisma-client.js";
import { seedPermissions } from "./seed/permissions.js";

// Entrada do seed (`npm run db:seed` / `prisma db seed`); usa DATABASE_URL do ambiente.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const prisma = createPrismaClient(url);
try {
  const count = await seedPermissions(prisma);
  console.log(`Seeded ${count} permissions`);
} finally {
  await prisma.$disconnect();
}
