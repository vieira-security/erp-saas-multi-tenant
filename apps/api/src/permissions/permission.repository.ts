import type { Permission, PrismaClient } from "../generated/prisma/client.js";

/**
 * Catálogo global (MODEL_SCOPE: `global`): sem `tenant_id` e sem TenantContext. Somente leitura em runtime;
 * escrita só pelo seed, como `erp_migrator`.
 */
export class PermissionRepository {
  constructor(private readonly db: Pick<PrismaClient, "permission">) {}

  findByCode(code: string): Promise<Permission | null> {
    return this.db.permission.findUnique({ where: { code } });
  }

  list(): Promise<Permission[]> {
    return this.db.permission.findMany({ orderBy: { code: "asc" } });
  }
}
