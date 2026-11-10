-- M6: ajuste da imutabilidade de venda do M5 (a migration 20261109000000 não é editada).
-- 1. DELIVERED -> CANCELLED passa a ser permitido (cancelar pedido entregue = estorno total, decisão de produto do M6).
-- 2. Em toda transição só mudam as colunas do estado de destino: CONFIRMED grava total/número/dia/confirmed_at;
--    PREPARING/READY/DELIVERED gravam só o próprio timestamp; CANCELLED grava só cancelled_at/cancelled_by/cancel_reason
--    (nenhum timestamp de outro estado aparece ou muda no cancelamento). Achado da auditoria do M5.
-- 3. TRUNCATE em orders, order_items e order_item_options rejeitado por trigger (como audit_logs). Achado da auditoria do M5.
-- O resto continua igual: DELETE rejeitado, filial/autor/criação imutáveis, venda congelada após a confirmação.

-- CreateOrReplaceFunction
CREATE OR REPLACE FUNCTION "forbid_order_mutation_after_confirmation"() RETURNS trigger
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
       'PREPARING>READY', 'PREPARING>CANCELLED', 'READY>DELIVERED', 'READY>CANCELLED', 'DELIVERED>CANCELLED') THEN
    RAISE EXCEPTION 'invalid order transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'CONFIRMED' THEN
    IF (NEW.preparing_at, NEW.ready_at, NEW.delivered_at, NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason)
       IS DISTINCT FROM (OLD.preparing_at, OLD.ready_at, OLD.delivered_at, OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason) THEN
      RAISE EXCEPTION 'order is frozen: a transition to CONFIRMED only records the confirmation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.total, NEW.number, NEW.business_date, NEW.confirmed_at) IS DISTINCT FROM (OLD.total, OLD.number, OLD.business_date, OLD.confirmed_at) THEN
    RAISE EXCEPTION 'order is frozen: total, number, business_date and confirmed_at never change after confirmation';
  END IF;
  IF (NEW.status = 'PREPARING' AND (NEW.ready_at, NEW.delivered_at, NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason)
        IS DISTINCT FROM (OLD.ready_at, OLD.delivered_at, OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason))
     OR (NEW.status = 'READY' AND (NEW.preparing_at, NEW.delivered_at, NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason)
        IS DISTINCT FROM (OLD.preparing_at, OLD.delivered_at, OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason))
     OR (NEW.status = 'DELIVERED' AND (NEW.preparing_at, NEW.ready_at, NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason)
        IS DISTINCT FROM (OLD.preparing_at, OLD.ready_at, OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason))
     OR (NEW.status = 'CANCELLED' AND (NEW.preparing_at, NEW.ready_at, NEW.delivered_at)
        IS DISTINCT FROM (OLD.preparing_at, OLD.ready_at, OLD.delivered_at)) THEN
    RAISE EXCEPTION 'order is frozen: a transition to % only records its own timestamp', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- Pedido cancelado depois de entregue mantém delivered_at (a ordem dos timestamps continua exigida).
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (CASE "status"
  WHEN 'EDITING' THEN "confirmed_at" IS NULL AND "preparing_at" IS NULL AND "ready_at" IS NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'CONFIRMED' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NULL AND "ready_at" IS NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'PREPARING' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NOT NULL AND "ready_at" IS NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'READY' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NOT NULL AND "ready_at" IS NOT NULL AND "delivered_at" IS NULL AND "cancelled_at" IS NULL
  WHEN 'DELIVERED' THEN "confirmed_at" IS NOT NULL AND "preparing_at" IS NOT NULL AND "ready_at" IS NOT NULL AND "delivered_at" IS NOT NULL AND "cancelled_at" IS NULL
  WHEN 'CANCELLED' THEN "cancelled_at" IS NOT NULL AND ("preparing_at" IS NULL OR "confirmed_at" IS NOT NULL) AND ("ready_at" IS NULL OR "preparing_at" IS NOT NULL) AND ("delivered_at" IS NULL OR "ready_at" IS NOT NULL)
  ELSE false END);

-- Vendas nunca são truncadas (também para o dono). Sempre lança.
-- CreateFunction
CREATE FUNCTION "forbid_sales_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales are never deleted: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

-- CreateTrigger
CREATE TRIGGER "orders_no_truncate" BEFORE TRUNCATE ON "orders" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_sales_truncate"();
-- CreateTrigger
CREATE TRIGGER "order_items_no_truncate" BEFORE TRUNCATE ON "order_items" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_sales_truncate"();
-- CreateTrigger
CREATE TRIGGER "order_item_options_no_truncate" BEFORE TRUNCATE ON "order_item_options" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_sales_truncate"();
