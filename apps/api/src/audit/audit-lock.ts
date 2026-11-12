import { Prisma } from "../generated/prisma/client.js";

/**
 * Trava `FOR UPDATE` da linha que vai ser alterada, para que o estado "antes" lido em seguida (`metadata.changes.from`)
 * seja o estado real no momento da alteração, mesmo com duas edições concorrentes. Só tabelas desta lista (nomes fixos;
 * nada vindo do cliente entra no SQL). `erp_app` tem UPDATE em todas, o que permite o FOR UPDATE.
 */
const LOCKABLE_TABLES = ["companies", "branches", "product_categories", "products", "kitchen_sectors"] as const;
export type AuditLockableTable = (typeof LOCKABLE_TABLES)[number];

/** `false` se a linha não existe no tenant (quem chama responde 404). */
export async function lockRowForAudit(tx: Prisma.TransactionClient, table: AuditLockableTable, tenantId: string, id: string): Promise<boolean> {
  if (!LOCKABLE_TABLES.includes(table)) throw new Error(`table not lockable: ${table}`);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM ${Prisma.raw(`"${table}"`)} WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  return rows.length === 1;
}

/** A organização é o próprio tenant (sem `tenant_id`). */
export async function lockTenantForAudit(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "tenants" WHERE id = ${tenantId}::uuid FOR UPDATE`;
  return rows.length === 1;
}
