-- M7: cozinha — setores de preparo, comandas por setor e impressão pelo navegador (contrato packages/contracts/src/kitchen.ts).
-- Tabelas de tenant (tenant_id uuid NOT NULL, FK direta para tenants) com FKs COMPOSTAS (tenant_id, x_id) ON DELETE/UPDATE
-- RESTRICT (sem CASCADE).
-- - kitchen_sectors: setores do TENANT; exatamente um padrão por tenant (índice único parcial + backfill abaixo); o padrão é
--   sempre ACTIVE (CHECK).
-- - branch_kitchen_sectors: a filial só liga/desliga (sem linha = ligado).
-- - products.kitchen_sector_id: NULL = setor padrão.
-- - kitchen_tickets: uma comanda por setor por pedido, nascida na confirmação; nome/código do setor são CÓPIAS; FK composta
--   com branch_id (mesma filial do pedido). Nunca apagada; só transições válidas (trigger).
-- - kitchen_ticket_items: vínculo comanda -> item do pedido, com order_id nas duas FKs (mesmo pedido e tenant). Append-only.
-- Backfill: setor padrão "Cozinha" (COZINHA) para todo tenant existente; permissão order.prepare no catálogo e nas roles
-- padrão (is_system) dos tenants existentes, idempotente, sem tocar role customizada. Pedidos já confirmados NÃO ganham
-- comandas (seguem o M5). Privilégios runtime: infrastructure/postgres/03-runtime-grants.sql.

-- CreateEnum
CREATE TYPE "kitchen_sector_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "kitchen_ticket_status" AS ENUM ('WAITING', 'PREPARING', 'READY', 'CANCELLED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "kitchen_sector_id" UUID;

-- CreateTable
CREATE TABLE "kitchen_sectors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "status" "kitchen_sector_status" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kitchen_sectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_kitchen_sectors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "sector_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_kitchen_sectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sector_id" UUID NOT NULL,
    "sector_name" TEXT NOT NULL,
    "sector_code" TEXT NOT NULL,
    "status" "kitchen_ticket_status" NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "last_printed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_ticket_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kitchen_ticket_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_sectors_tenant_id_code_key" ON "kitchen_sectors"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_sectors_tenant_id_id_key" ON "kitchen_sectors"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "branch_kitchen_sectors_tenant_id_sector_id_idx" ON "branch_kitchen_sectors"("tenant_id", "sector_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_kitchen_sectors_tenant_id_branch_id_sector_id_key" ON "branch_kitchen_sectors"("tenant_id", "branch_id", "sector_id");

-- CreateIndex
CREATE INDEX "kitchen_tickets_tenant_id_branch_id_order_id_idx" ON "kitchen_tickets"("tenant_id", "branch_id", "order_id");

-- CreateIndex
CREATE INDEX "kitchen_tickets_tenant_id_branch_id_created_at_idx" ON "kitchen_tickets"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "kitchen_tickets_tenant_id_sector_id_idx" ON "kitchen_tickets"("tenant_id", "sector_id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_tickets_tenant_id_order_id_sector_id_key" ON "kitchen_tickets"("tenant_id", "order_id", "sector_id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_tickets_tenant_id_order_id_id_key" ON "kitchen_tickets"("tenant_id", "order_id", "id");

-- CreateIndex
CREATE INDEX "kitchen_ticket_items_tenant_id_order_id_ticket_id_idx" ON "kitchen_ticket_items"("tenant_id", "order_id", "ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_ticket_items_tenant_id_order_id_order_item_id_key" ON "kitchen_ticket_items"("tenant_id", "order_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_tenant_id_order_id_id_key" ON "order_items"("tenant_id", "order_id", "id");

-- CreateIndex
CREATE INDEX "products_tenant_id_kitchen_sector_id_idx" ON "products"("tenant_id", "kitchen_sector_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_kitchen_sector_id_fkey" FOREIGN KEY ("tenant_id", "kitchen_sector_id") REFERENCES "kitchen_sectors"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_sectors" ADD CONSTRAINT "kitchen_sectors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_kitchen_sectors" ADD CONSTRAINT "branch_kitchen_sectors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_kitchen_sectors" ADD CONSTRAINT "branch_kitchen_sectors_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_kitchen_sectors" ADD CONSTRAINT "branch_kitchen_sectors_tenant_id_sector_id_fkey" FOREIGN KEY ("tenant_id", "sector_id") REFERENCES "kitchen_sectors"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_branch_id_order_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "order_id") REFERENCES "orders"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_sector_id_fkey" FOREIGN KEY ("tenant_id", "sector_id") REFERENCES "kitchen_sectors"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_tenant_id_order_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "order_id", "ticket_id") REFERENCES "kitchen_tickets"("tenant_id", "order_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_tenant_id_order_id_order_item_id_fkey" FOREIGN KEY ("tenant_id", "order_id", "order_item_id") REFERENCES "order_items"("tenant_id", "order_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Índice único PARCIAL (não representável no schema Prisma; ver docs/database.md): no máximo UM setor padrão por tenant.
-- "Pelo menos um" vem do backfill abaixo, do provisionamento e da aplicação (make-default troca o padrão numa transação).
CREATE UNIQUE INDEX "kitchen_sectors_one_default_per_tenant_key" ON "kitchen_sectors"("tenant_id") WHERE "is_default";

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "kitchen_sectors" ADD CONSTRAINT "kitchen_sectors_name_check" CHECK (btrim("name") <> '' AND char_length("name") <= 60);
ALTER TABLE "kitchen_sectors" ADD CONSTRAINT "kitchen_sectors_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "kitchen_sectors" ADD CONSTRAINT "kitchen_sectors_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 9999);
-- O setor padrão nunca fica INACTIVE (desativar o padrão = 409 kitchen_sector_default_required na aplicação).
ALTER TABLE "kitchen_sectors" ADD CONSTRAINT "kitchen_sectors_default_active_check" CHECK (NOT "is_default" OR "status" = 'ACTIVE');

ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_sector_name_check" CHECK (btrim("sector_name") <> '');
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_sector_code_check" CHECK ("sector_code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
-- Timestamps coerentes com o status (o ELSE false fecha o CASE para qualquer valor futuro do enum). READY sempre tem
-- started_at (o atalho "pronto" a partir de WAITING grava início e pronto juntos); CANCELLED mantém o que já tinha.
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_status_check" CHECK (CASE "status"
  WHEN 'WAITING' THEN "started_at" IS NULL AND "ready_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'PREPARING' THEN "started_at" IS NOT NULL AND "ready_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'READY' THEN "started_at" IS NOT NULL AND "ready_at" IS NOT NULL AND "cancelled_at" IS NULL
  WHEN 'CANCELLED' THEN "cancelled_at" IS NOT NULL AND ("ready_at" IS NULL OR "started_at" IS NOT NULL)
  ELSE false END);
-- Vias: contagem não negativa; "já impressa" <=> data da última impressão.
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_print_check" CHECK ("print_count" >= 0 AND ("print_count" = 0) = ("last_printed_at" IS NULL));

-- Comanda (defesa em profundidade; a aplicação já trava pedido -> comandas e valida antes).
-- INSERT: nasce WAITING, sem timestamps de estado e nunca impressa, com o pedido CONFIRMED (lido FOR SHARE: uma transição
-- em andamento do pedido é esperada). DELETE: sempre rejeitado. UPDATE: identidade, pedido, filial, setor, cópias e criação
-- nunca mudam; contagem de vias só cresce; sem troca de status só a impressão (print_count/last_printed_at) e updated_at
-- mudam; troca de status só pelas setas WAITING>PREPARING, WAITING>READY, PREPARING>READY e {WAITING,PREPARING,READY}>
-- CANCELLED, sem imprimir junto, e timestamp de estado já gravado nunca muda. tenant_id fica com o trigger genérico.
-- CreateFunction
CREATE FUNCTION "guard_kitchen_ticket"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_status order_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kitchen tickets are never deleted: DELETE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Cancelling the order cancels its tickets (status CANCELLED).';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'WAITING' OR NEW.print_count <> 0 OR NEW.last_printed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a kitchen ticket is created WAITING and never printed';
    END IF;
    SELECT o.status INTO order_status FROM orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id FOR SHARE;
    IF order_status IS NOT NULL AND order_status <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'kitchen tickets are created on confirmation: order is % (expected CONFIRMED)', order_status;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.branch_id, NEW.order_id, NEW.sector_id, NEW.sector_name, NEW.sector_code, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.branch_id, OLD.order_id, OLD.sector_id, OLD.sector_name, OLD.sector_code, OLD.created_at) THEN
    RAISE EXCEPTION 'kitchen ticket is immutable: id, order, branch, sector copies and created_at never change';
  END IF;
  IF NEW.print_count < OLD.print_count THEN
    RAISE EXCEPTION 'kitchen ticket print count never decreases';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (NEW.started_at, NEW.ready_at, NEW.cancelled_at) IS DISTINCT FROM (OLD.started_at, OLD.ready_at, OLD.cancelled_at) THEN
      RAISE EXCEPTION 'kitchen ticket is frozen: % ticket only changes through a status transition or a print', OLD.status;
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status::text || '>' || NEW.status::text) NOT IN (
       'WAITING>PREPARING', 'WAITING>READY', 'PREPARING>READY',
       'WAITING>CANCELLED', 'PREPARING>CANCELLED', 'READY>CANCELLED') THEN
    RAISE EXCEPTION 'invalid kitchen ticket transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF (NEW.print_count, NEW.last_printed_at) IS DISTINCT FROM (OLD.print_count, OLD.last_printed_at)
     OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
     OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
     OR (NEW.status = 'CANCELLED' AND (NEW.started_at, NEW.ready_at) IS DISTINCT FROM (OLD.started_at, OLD.ready_at)) THEN
    RAISE EXCEPTION 'kitchen ticket is frozen: a transition to % only records its own timestamp', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- Item da comanda: append-only. INSERT só com a comanda WAITING e nunca impressa (lida FOR SHARE); UPDATE e DELETE sempre
-- rejeitados. O que a cozinha vê é o snapshot da venda (order_items/order_item_options), também imutável depois da
-- confirmação.
-- CreateFunction
CREATE FUNCTION "guard_kitchen_ticket_item"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ticket_status kitchen_ticket_status;
  ticket_prints integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'kitchen ticket items never change: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  SELECT t.status, t.print_count INTO ticket_status, ticket_prints FROM kitchen_tickets t
  WHERE t.tenant_id = NEW.tenant_id AND t.order_id = NEW.order_id AND t.id = NEW.ticket_id FOR SHARE;
  IF ticket_status IS NOT NULL AND (ticket_status <> 'WAITING' OR ticket_prints <> 0) THEN
    RAISE EXCEPTION 'kitchen ticket items are only added to a new ticket (current: %, printed % time(s))', ticket_status, ticket_prints;
  END IF;
  RETURN NEW;
END;
$$;

-- CreateTrigger
CREATE TRIGGER "kitchen_tickets_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "kitchen_tickets"
FOR EACH ROW EXECUTE FUNCTION "guard_kitchen_ticket"();

-- CreateTrigger
CREATE TRIGGER "kitchen_ticket_items_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "kitchen_ticket_items"
FOR EACH ROW EXECUTE FUNCTION "guard_kitchen_ticket_item"();

-- Comandas e seus itens nunca são truncados (função compartilhada criada em 20261110010000_adjust_order_immutability).
-- CreateTrigger
CREATE TRIGGER "kitchen_tickets_no_truncate" BEFORE TRUNCATE ON "kitchen_tickets" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_sales_truncate"();
-- CreateTrigger
CREATE TRIGGER "kitchen_ticket_items_no_truncate" BEFORE TRUNCATE ON "kitchen_ticket_items" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_sales_truncate"();

-- tenant_id imutável (função compartilhada criada em 20261002120000_make_tenant_id_immutable).

-- CreateTrigger
CREATE TRIGGER "kitchen_sectors_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "kitchen_sectors"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "branch_kitchen_sectors_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "branch_kitchen_sectors"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "kitchen_tickets_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "kitchen_tickets"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "kitchen_ticket_items_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "kitchen_ticket_items"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- Backfill (idempotente). IDs UUIDv7 gerados em SQL (PostgreSQL 17 não tem uuidv7()): 48 bits de milissegundos Unix sobre
-- um UUID aleatório, com os bits de versão ajustados de 4 para 7 (mesmo formato de src/database/uuid-v7.ts).

-- Setor padrão "Cozinha" (COZINHA) para todo tenant existente que ainda não tem padrão.
INSERT INTO "kitchen_sectors" ("id", "tenant_id", "name", "code", "is_default", "status", "sort_order", "created_at", "updated_at")
SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
         PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
       t."id", 'Cozinha', 'COZINHA', true, 'ACTIVE', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "kitchen_sectors" s WHERE s."tenant_id" = t."id" AND s."is_default");

-- Permissão nova do catálogo global (decisão de produto de 10/11/2026). O seed (`npm run db:seed`) mantém module/description
-- alinhados ao catálogo; aqui ela só precisa existir para o backfill das roles.
INSERT INTO "permissions" ("id", "code", "module", "description")
VALUES (encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
        'order.prepare', 'orders', 'Preparar pedidos (cozinha)')
ON CONFLICT ("code") DO NOTHING;

-- order.prepare nas roles PADRÃO (is_system) de todo tenant: Proprietário, Gerente, Atendente e Cozinha (matriz em
-- apps/api/src/tenants/default-roles.ts). Role customizada (is_system = false), mesmo com código padrão, não é tocada.
INSERT INTO "role_permissions" ("id", "tenant_id", "role_id", "permission_id")
SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
         PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
       r."tenant_id", r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."code" = 'order.prepare' AND r."is_system" AND r."code" IN ('OWNER', 'MANAGER', 'ATTENDANT', 'KITCHEN')
ON CONFLICT ("tenant_id", "role_id", "permission_id") DO NOTHING;
