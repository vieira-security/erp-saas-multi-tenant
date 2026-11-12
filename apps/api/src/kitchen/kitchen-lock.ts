import type { KitchenSectorStatus, KitchenTicketStatus } from "@erp/contracts";
import type { Prisma } from "../generated/prisma/client.js";
import type { RoutableSector } from "./kitchen-rules.js";

/**
 * Travas de linha do M7 (SQL bruto porque o Prisma não expõe FOR UPDATE/SHARE). Todo comando filtra `tenant_id`
 * explícito, vindo do TenantContext (quem chama passa `scope.tenantId()`).
 *
 * Ordem global (sem deadlock): pedido -> filial/empresa -> caixa -> contador (M5/M6) -> setores do tenant (por `id`) ->
 * ajustes de setor da filial -> comandas do pedido (por `id`). Quem só mexe em setor começa pelos setores.
 * - Confirmação: setores FOR SHARE (todos do tenant, por `id`) + ajustes da filial FOR SHARE. Desativar setor, trocar o
 *   padrão e ligar/desligar setor na filial travam a(s) linha(s) do setor FOR UPDATE: ou esperam a confirmação terminar,
 *   ou a confirmação espera o commit deles e relê o estado novo (READ COMMITTED). Nunca nasce comanda num setor que, no
 *   commit, já estava desativado/desligado.
 * - Trocar o padrão trava TODOS os setores do tenant (por `id`): duas trocas em paralelo se serializam e a segunda relê
 *   quem é o padrão agora.
 */

type SectorRow = { id: string; name: string; code: string; isDefault: boolean; status: KitchenSectorStatus };

/** Todos os setores do tenant, travados FOR SHARE, com o ligado/desligado da filial (também FOR SHARE). */
export async function lockSectorsForRouting(tx: Prisma.TransactionClient, tenantId: string, branchId: string): Promise<RoutableSector[]> {
  const sectors = await tx.$queryRaw<SectorRow[]>`
    SELECT id::text AS id, name, code, is_default AS "isDefault", status::text AS status FROM kitchen_sectors
    WHERE tenant_id = ${tenantId}::uuid
    ORDER BY id FOR SHARE`;
  const settings = await tx.$queryRaw<{ sectorId: string; enabled: boolean }[]>`
    SELECT sector_id::text AS "sectorId", enabled FROM branch_kitchen_sectors
    WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid
    ORDER BY sector_id FOR SHARE`;
  const enabled = new Map(settings.map((s) => [s.sectorId, s.enabled]));
  return sectors.map((s) => ({ ...s, enabledInBranch: enabled.get(s.id) ?? true }));
}

/** Um setor do tenant, travado FOR UPDATE, com o estado MAIS RECENTE (`null` = não existe no tenant -> 404). */
export async function lockSector(tx: Prisma.TransactionClient, tenantId: string, sectorId: string): Promise<SectorRow | null> {
  const rows = await tx.$queryRaw<SectorRow[]>`
    SELECT id::text AS id, name, code, is_default AS "isDefault", status::text AS status FROM kitchen_sectors
    WHERE tenant_id = ${tenantId}::uuid AND id = ${sectorId}::uuid
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** Todos os setores do tenant FOR UPDATE, por `id` (troca do padrão). */
export async function lockAllSectors(tx: Prisma.TransactionClient, tenantId: string): Promise<SectorRow[]> {
  return tx.$queryRaw<SectorRow[]>`
    SELECT id::text AS id, name, code, is_default AS "isDefault", status::text AS status FROM kitchen_sectors
    WHERE tenant_id = ${tenantId}::uuid
    ORDER BY id FOR UPDATE`;
}

export interface LockedTicket {
  readonly id: string;
  readonly status: KitchenTicketStatus;
  readonly startedAt: Date | null;
}

/** Comandas do pedido FOR UPDATE, por `id`. Quem chama já travou o pedido (ordem pedido -> comandas). */
export async function lockOrderTickets(tx: Prisma.TransactionClient, tenantId: string, orderId: string): Promise<LockedTicket[]> {
  return tx.$queryRaw<LockedTicket[]>`
    SELECT id::text AS id, status::text AS status, started_at AS "startedAt" FROM kitchen_tickets
    WHERE tenant_id = ${tenantId}::uuid AND order_id = ${orderId}::uuid
    ORDER BY id FOR UPDATE`;
}

/**
 * Conta UMA via, atomicamente (UPDATE ... RETURNING): duas impressões simultâneas da mesma comanda se serializam na linha
 * e recebem vias diferentes (1 e 2), nunca repetidas. `null` = comanda inexistente nesta filial/tenant (404).
 */
export async function countPrint(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  ticketId: string,
  now: Date,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ copy: number }[]>`
    UPDATE kitchen_tickets SET print_count = print_count + 1, last_printed_at = ${now}, updated_at = ${now}
    WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${ticketId}::uuid
    RETURNING print_count AS copy`;
  return rows[0]?.copy ?? null;
}
