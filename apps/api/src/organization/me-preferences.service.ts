import { Inject, Injectable } from "@nestjs/common";
import type { CatalogView, MePreferencesDto, UpdateMePreferencesRequest } from "@erp/contracts";
import { AuthContextService } from "../auth/context/auth-context.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { uuidV7 } from "../database/uuid-v7.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { oneOf, parseInput, required } from "../http/input.js";
import { TenantScope } from "../tenancy/tenant-scope.js";

/** Mesmos valores de `CATALOG_VIEWS` do contrato (só `import type` na API); o typecheck e um teste comparam. */
export const CATALOG_VIEWS = ["GRID", "LIST"] as const satisfies readonly CatalogView[];
type MissingView = Exclude<CatalogView, (typeof CATALOG_VIEWS)[number]>;
const viewsMatchContract: [MissingView] extends [never] ? true : never = true;
void viewsMatchContract;

/** Defaults do contrato para quem nunca gravou (sem linha em `user_preferences`). */
export const DEFAULT_PREFERENCES: MePreferencesDto = Object.freeze({ catalogView: "GRID" });

/** Corpo do PUT: `catalogView` obrigatório e da lista; campo desconhecido (inclusive `userId`/`tenantId`) = `unknown_field`. */
export function parseUpdatePreferences(body: unknown): UpdateMePreferencesRequest {
  return parseInput(body, { catalogView: required(oneOf(CATALOG_VIEWS)) });
}

function toCatalogView(value: string): CatalogView {
  // O CHECK do banco garante a lista; valor fora dela (impossível) cai no default em vez de vazar.
  return (CATALOG_VIEWS as readonly string[]).includes(value) ? (value as CatalogView) : DEFAULT_PREFERENCES.catalogView;
}

/**
 * Preferências do PRÓPRIO usuário (KAN-42): tenant e usuário só do AuthContext (nunca de rota/corpo), então ninguém lê ou
 * grava as de outro. Sem linha = defaults. O PUT é um upsert atômico (INSERT ... ON CONFLICT DO UPDATE), seguro em
 * paralelo; repetir o mesmo valor não regrava. Preferência de interface não entra no histórico de auditoria.
 */
@Injectable()
export class MePreferencesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TenantScope) private readonly scope: TenantScope,
    @Inject(AuthContextService) private readonly auth: AuthContextService,
  ) {}

  async get(): Promise<MePreferencesDto> {
    const { userId } = this.auth.require();
    const row = await this.prisma.userPreference.findFirst({ where: this.scope.where({ userId }), select: { catalogView: true } });
    return row ? { catalogView: toCatalogView(row.catalogView) } : { ...DEFAULT_PREFERENCES };
  }

  async update(input: UpdateMePreferencesRequest): Promise<MePreferencesDto> {
    const { userId } = this.auth.require();
    const tenantId = this.scope.tenantId();
    const rows = await this.prisma.$queryRaw<{ catalogView: string }[]>`
      INSERT INTO user_preferences (id, tenant_id, user_id, catalog_view, created_at, updated_at)
      VALUES (${uuidV7()}::uuid, ${tenantId}::uuid, ${userId}::uuid, ${input.catalogView}, now(), now())
      ON CONFLICT (tenant_id, user_id)
      DO UPDATE SET catalog_view = EXCLUDED.catalog_view, updated_at = now()
      WHERE user_preferences.catalog_view IS DISTINCT FROM EXCLUDED.catalog_view
      RETURNING catalog_view AS "catalogView"`;
    // Sem linha devolvida = valor igual ao gravado (o WHERE do DO UPDATE não regravou).
    return { catalogView: toCatalogView(rows[0]?.catalogView ?? input.catalogView) };
  }
}
