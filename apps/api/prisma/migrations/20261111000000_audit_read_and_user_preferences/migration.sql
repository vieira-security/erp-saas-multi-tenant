-- KAN-41 (histórico de auditoria) e KAN-42 (preferências do usuário). Contratos: packages/contracts/src/audit.ts e o fim
-- de packages/contracts/src/me.ts. Decisões de produto de 10/11/2026.
-- - user_preferences: tabela de TENANT (tenant_id uuid NOT NULL, FK direta para tenants) com FK COMPOSTA
--   (tenant_id, user_id) -> users ON DELETE/UPDATE RESTRICT; uma linha por usuário (único (tenant_id, user_id)); sem
--   linha = defaults do contrato. tenant_id imutável (forbid_tenant_id_change). Sem DELETE em runtime.
-- - Permissões novas do catálogo global: audit.read (Proprietário e Gerente) e audit.read_tenant (só o Proprietário),
--   com backfill idempotente nas roles PADRÃO (is_system) dos tenants existentes, sem tocar role customizada.
-- - audit_logs não muda: continua append-only (triggers + só SELECT/INSERT para erp_app). Nenhum índice novo: a leitura
--   (tenant + filiais visíveis + ordem created_at desc) é atendida por (tenant_id, created_at) e
--   (tenant_id, branch_id, created_at), ver docs/database.md.
-- Privilégios runtime: infrastructure/postgres/03-runtime-grants.sql.

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "catalog_view" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representável no schema Prisma; mesmos valores de CATALOG_VIEWS do contrato)
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_catalog_view_check" CHECK ("catalog_view" IN ('GRID', 'LIST'));

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_tenant_id_user_id_key" ON "user_preferences"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTrigger
CREATE TRIGGER "user_preferences_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "user_preferences"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- Backfill (idempotente). IDs UUIDv7 gerados em SQL, mesmo formato da migration 20261110020000_create_kitchen.

-- Permissões novas do catálogo global. O seed (`npm run db:seed`) mantém module/description alinhados ao catálogo; aqui
-- elas só precisam existir para o backfill das roles.
INSERT INTO "permissions" ("id", "code", "module", "description")
VALUES (encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
        'audit.read', 'audit', 'Visualizar histórico de auditoria'),
       (encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
        'audit.read_tenant', 'audit', 'Visualizar auditoria do tenant (eventos sem filial)')
ON CONFLICT ("code") DO NOTHING;

-- Matriz (apps/api/src/tenants/default-roles.ts): audit.read para OWNER e MANAGER; audit.read_tenant só para OWNER.
-- Só roles PADRÃO (is_system); role customizada (is_system = false), mesmo com código padrão, não é tocada.
INSERT INTO "role_permissions" ("id", "tenant_id", "role_id", "permission_id")
SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
         PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
       r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p
  ON (p."code" = 'audit.read' AND r."code" IN ('OWNER', 'MANAGER'))
  OR (p."code" = 'audit.read_tenant' AND r."code" = 'OWNER')
WHERE r."is_system"
ON CONFLICT ("tenant_id", "role_id", "permission_id") DO NOTHING;
