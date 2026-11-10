-- M5: pedidos do PDV (balcão com senha). Tabelas de tenant (tenant_id uuid NOT NULL, FK direta para tenants) com FKs
-- COMPOSTAS (tenant_id, x_id) ON DELETE/UPDATE RESTRICT (sem CASCADE). Dinheiro em numeric(12,2).
-- Itens e opções são cópias (snapshot) do cardápio: order_items.product_id tem FK (produtos nunca são apagados);
-- order_item_options.option_id e linked_product_id são referências históricas SEM FK (opções são apagadas na
-- substituição de grupos do M4). Vendas nunca são apagadas: triggers abaixo impõem a imutabilidade também no banco.
-- Pagamento (M6) e fiscal (M9) fora. Privilégios runtime: infrastructure/postgres/03-runtime-grants.sql.

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('EDITING', 'CONFIRMED', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "order_status" NOT NULL,
    "number" INTEGER,
    "business_date" DATE,
    "total" DECIMAL(12,2) NOT NULL,
    "created_by" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "preparing_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "product_code" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "group_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta" DECIMAL(12,2) NOT NULL,
    "linked_product_id" UUID,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_item_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_order_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "last_number" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_order_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_tenant_id_branch_id_created_at_idx" ON "orders"("tenant_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_tenant_id_branch_id_status_idx" ON "orders"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "orders_tenant_id_created_by_idx" ON "orders"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "orders_tenant_id_cancelled_by_idx" ON "orders"("tenant_id", "cancelled_by");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_id_key" ON "orders"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_branch_id_business_date_number_key" ON "orders"("tenant_id", "branch_id", "business_date", "number");

-- CreateIndex
CREATE INDEX "order_items_tenant_id_product_id_idx" ON "order_items"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_tenant_id_order_id_sort_order_key" ON "order_items"("tenant_id", "order_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_tenant_id_id_key" ON "order_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_options_tenant_id_order_item_id_sort_order_key" ON "order_item_options"("tenant_id", "order_item_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_options_tenant_id_order_item_id_option_id_key" ON "order_item_options"("tenant_id", "order_item_id", "option_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_order_counters_tenant_id_branch_id_business_date_key" ON "branch_order_counters"("tenant_id", "branch_id", "business_date");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_created_by_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_cancelled_by_fkey" FOREIGN KEY ("tenant_id", "cancelled_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_tenant_id_order_item_id_fkey" FOREIGN KEY ("tenant_id", "order_item_id") REFERENCES "order_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_order_counters" ADD CONSTRAINT "branch_order_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_order_counters" ADD CONSTRAINT "branch_order_counters_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "orders" ADD CONSTRAINT "orders_number_check" CHECK ("number" IS NULL OR "number" >= 1);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK ("total" >= 0);
-- Número, dia de operação e confirmação nascem juntos (na confirmação) e nunca existem um sem o outro.
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmation_check" CHECK (("number" IS NULL) = ("business_date" IS NULL) AND ("number" IS NULL) = ("confirmed_at" IS NULL));
-- Timestamps coerentes com o status (o ELSE false fecha o CASE para qualquer valor futuro do enum).
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (CASE "status"
  WHEN 'EDITING' THEN "confirmed_at" IS NULL AND "preparing_at" IS NULL AND "ready_at" IS NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'CONFIRMED' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NULL AND "ready_at" IS NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'PREPARING' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NOT NULL AND "ready_at" IS NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'READY' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NOT NULL AND "ready_at" IS NOT NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'DELIVERED' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NOT NULL AND "ready_at" IS NOT NULL AND "delivered_at" IS NOT NULL AND "cancelled_at" IS NULL
  WHEN 'CANCELLED' THEN "cancelled_at" IS NOT NULL AND "delivered_at" IS NULL AND ("preparing_at" IS NULL OR "confirmed_at" IS NOT NULL) AND ("ready_at" IS NULL OR "preparing_at" IS NOT NULL)
  ELSE false END);
-- Quem cancelou só existe em pedido cancelado; motivo obrigatório quando o pedido já tinha sido confirmado.
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancellation_check" CHECK ((("status" = 'CANCELLED') = ("cancelled_by" IS NOT NULL)) AND ("status" = 'CANCELLED' OR "cancel_reason" IS NULL) AND ("status" <> 'CANCELLED' OR "confirmed_at" IS NULL OR "cancel_reason" IS NOT NULL));
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancel_reason_check" CHECK ("cancel_reason" IS NULL OR (btrim("cancel_reason") <> '' AND char_length("cancel_reason") <= 200));

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unit_price_check" CHECK ("unit_price" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_line_total_check" CHECK ("line_total" = "unit_price" * "quantity");
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_name_check" CHECK (btrim("product_name") <> '');
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_code_check" CHECK ("product_code" IS NULL OR "product_code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_note_check" CHECK ("note" IS NULL OR (btrim("note") <> '' AND char_length("note") <= 140));
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 99);

ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_group_name_check" CHECK (btrim("group_name") <> '');
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_price_delta_check" CHECK ("price_delta" >= 0);
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 999);

ALTER TABLE "branch_order_counters" ADD CONSTRAINT "branch_order_counters_last_number_check" CHECK ("last_number" >= 1);

-- Imutabilidade de venda (defesa em profundidade; a aplicação já trava e valida antes).
-- Itens e opções só mudam (INSERT/UPDATE/DELETE) enquanto o pedido está EDITING. O status do pedido é lido com
-- FOR SHARE: uma confirmação em andamento (que trava o pedido FOR UPDATE) é esperada e o status relido depois do commit.
-- Pedido inexistente (status NULL) segue para a FK, que dá o erro correto.
-- CreateFunction
CREATE FUNCTION "forbid_order_line_change_unless_editing"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sides jsonb[] := ARRAY[]::jsonb[];
  side jsonb;
  target_order uuid;
  current_status order_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN sides := array_append(sides, to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN sides := array_append(sides, to_jsonb(NEW)); END IF;
  FOREACH side IN ARRAY sides LOOP
    IF TG_TABLE_NAME = 'order_items' THEN
      target_order := (side->>'order_id')::uuid;
    ELSE
      SELECT i.order_id INTO target_order FROM order_items i
      WHERE i.tenant_id = (side->>'tenant_id')::uuid AND i.id = (side->>'order_item_id')::uuid;
    END IF;
    current_status := NULL;
    SELECT o.status INTO current_status FROM orders o
    WHERE o.tenant_id = (side->>'tenant_id')::uuid AND o.id = target_order FOR SHARE;
    IF current_status IS NOT NULL AND current_status <> 'EDITING' THEN
      RAISE EXCEPTION 'order is not editable: % on %.% requires the order to be EDITING (current: %)',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_status
        USING HINT = 'Items of a confirmed order are part of a sale and never change.';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Pedido: DELETE sempre rejeitado (vendas nunca são apagadas; rascunho descartado vira CANCELLED). Em UPDATE:
-- filial, autor e criação nunca mudam; transição de status só pelas setas do contrato; depois da confirmação total,
-- número, dia e confirmed_at ficam congelados e timestamp de estado já gravado não muda; sem troca de status, só
-- updated_at (e, em EDITING, o total) pode mudar. tenant_id fica com o trigger orders_tenant_id_immutable.
-- CreateFunction
CREATE FUNCTION "forbid_order_mutation_after_confirmation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders are never deleted: DELETE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Cancel the order instead (status CANCELLED).';
  END IF;
  IF (NEW.id, NEW.branch_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.branch_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'order is immutable: id, branch_id, created_by and created_at never change';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (NEW.number, NEW.business_date, NEW.confirmed_at, NEW.preparing_at, NEW.ready_at, NEW.delivered_at,
        NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason)
       IS DISTINCT FROM (OLD.number, OLD.business_date, OLD.confirmed_at, OLD.preparing_at, OLD.ready_at, OLD.delivered_at,
        OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason)
       OR (OLD.status <> 'EDITING' AND NEW.total IS DISTINCT FROM OLD.total) THEN
      RAISE EXCEPTION 'order is frozen: % order only changes through a status transition', OLD.status;
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status::text || '>' || NEW.status::text) NOT IN (
       'EDITING>CONFIRMED', 'EDITING>CANCELLED', 'CONFIRMED>PREPARING', 'CONFIRMED>CANCELLED',
       'PREPARING>READY', 'PREPARING>CANCELLED', 'READY>DELIVERED', 'READY>CANCELLED') THEN
    RAISE EXCEPTION 'invalid order transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'EDITING' THEN
    IF (NEW.total, NEW.number, NEW.business_date, NEW.confirmed_at) IS DISTINCT FROM (OLD.total, OLD.number, OLD.business_date, OLD.confirmed_at)
       OR (OLD.preparing_at IS NOT NULL AND NEW.preparing_at IS DISTINCT FROM OLD.preparing_at)
       OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at) THEN
      RAISE EXCEPTION 'order is frozen: total, number, business_date and recorded state timestamps never change after confirmation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- CreateTrigger
CREATE TRIGGER "orders_immutable_after_confirmation"
BEFORE UPDATE OR DELETE ON "orders"
FOR EACH ROW EXECUTE FUNCTION "forbid_order_mutation_after_confirmation"();

-- CreateTrigger
CREATE TRIGGER "order_items_editing_only"
BEFORE INSERT OR UPDATE OR DELETE ON "order_items"
FOR EACH ROW EXECUTE FUNCTION "forbid_order_line_change_unless_editing"();

-- CreateTrigger
CREATE TRIGGER "order_item_options_editing_only"
BEFORE INSERT OR UPDATE OR DELETE ON "order_item_options"
FOR EACH ROW EXECUTE FUNCTION "forbid_order_line_change_unless_editing"();

-- tenant_id imutável (função compartilhada criada em 20261002120000_make_tenant_id_immutable).

-- CreateTrigger
CREATE TRIGGER "orders_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "orders"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "order_items_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "order_items"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "order_item_options_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "order_item_options"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "branch_order_counters_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "branch_order_counters"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();
