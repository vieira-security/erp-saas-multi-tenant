-- M6: caixa e pagamentos. Tabelas de tenant (tenant_id uuid NOT NULL, FK direta para tenants) com FKs COMPOSTAS
-- ON DELETE/UPDATE RESTRICT (sem CASCADE). Pagamento, estorno e movimento carregam branch_id e apontam para o caixa por
-- (tenant_id, branch_id, cash_session_id): caem sempre num caixa da MESMA filial do pedido (garantido no banco).
-- O estorno aponta para payments(tenant_id, branch_id, id, order_id, method, amount): mesmo pedido, método e valor.
-- Registros financeiros nunca mudam nem são apagados (triggers abaixo). Dinheiro em numeric(12,2). Fiscal fica no M9.
-- Privilégios runtime: infrastructure/postgres/03-runtime-grants.sql.

-- CreateEnum
CREATE TYPE "cash_session_status" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "cash_movement_type" AS ENUM ('SUPPLY', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'PIX', 'DEBIT_CARD', 'CREDIT_CARD');

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "cash_session_status" NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "opening_amount" DECIMAL(12,2) NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "expected_cash" DECIMAL(12,2),
    "counted_cash" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "justification" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "cash_session_id" UUID NOT NULL,
    "type" "cash_movement_type" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "cash_session_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "received_amount" DECIMAL(12,2),
    "change" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "cash_session_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_branch_id_opened_at_idx" ON "cash_sessions"("tenant_id", "branch_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_opened_by_idx" ON "cash_sessions"("tenant_id", "opened_by");

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_closed_by_idx" ON "cash_sessions"("tenant_id", "closed_by");

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_tenant_id_branch_id_id_key" ON "cash_sessions"("tenant_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "cash_movements_tenant_id_branch_id_cash_session_id_idx" ON "cash_movements"("tenant_id", "branch_id", "cash_session_id");

-- CreateIndex
CREATE INDEX "cash_movements_tenant_id_created_by_idx" ON "cash_movements"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "payments_tenant_id_branch_id_order_id_idx" ON "payments"("tenant_id", "branch_id", "order_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_branch_id_cash_session_id_idx" ON "payments"("tenant_id", "branch_id", "cash_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_branch_id_id_order_id_method_amount_key" ON "payments"("tenant_id", "branch_id", "id", "order_id", "method", "amount");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_branch_id_cash_session_id_idx" ON "refunds"("tenant_id", "branch_id", "cash_session_id");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_created_by_idx" ON "refunds"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_tenant_id_branch_id_payment_id_order_id_method_amou_key" ON "refunds"("tenant_id", "branch_id", "payment_id", "order_id", "method", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_branch_id_id_key" ON "orders"("tenant_id", "branch_id", "id");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_opened_by_fkey" FOREIGN KEY ("tenant_id", "opened_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_closed_by_fkey" FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_branch_id_cash_session_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "cash_session_id") REFERENCES "cash_sessions"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_created_by_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_branch_id_order_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "order_id") REFERENCES "orders"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_branch_id_cash_session_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "cash_session_id") REFERENCES "cash_sessions"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_branch_id_payment_id_order_id_method_amo_fkey" FOREIGN KEY ("tenant_id", "branch_id", "payment_id", "order_id", "method", "amount") REFERENCES "payments"("tenant_id", "branch_id", "id", "order_id", "method", "amount") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_branch_id_cash_session_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "cash_session_id") REFERENCES "cash_sessions"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_created_by_fkey" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_amounts_check" CHECK ("opening_amount" >= 0 AND ("expected_cash" IS NULL OR "expected_cash" >= 0) AND ("counted_cash" IS NULL OR "counted_cash" >= 0));
-- CLOSED <=> todos os campos de fechamento preenchidos; justificativa só em caixa fechado.
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closing_check" CHECK (
  ("status" = 'CLOSED') = ("closed_by" IS NOT NULL) AND ("status" = 'CLOSED') = ("closed_at" IS NOT NULL)
  AND ("status" = 'CLOSED') = ("expected_cash" IS NOT NULL) AND ("status" = 'CLOSED') = ("counted_cash" IS NOT NULL)
  AND ("status" = 'CLOSED') = ("difference" IS NOT NULL) AND ("status" = 'CLOSED' OR "justification" IS NULL));
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_difference_check" CHECK ("difference" IS NULL OR "difference" = "counted_cash" - "expected_cash");
-- Qualquer diferença exige justificativa (3..500 após trim).
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_justification_check" CHECK (("difference" IS NULL OR "difference" = 0 OR "justification" IS NOT NULL) AND ("justification" IS NULL OR (char_length(btrim("justification")) >= 3 AND char_length("justification") <= 500)));

ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_check" CHECK ("amount" > 0);
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check" CHECK (char_length(btrim("reason")) >= 3 AND char_length("reason") <= 200);

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK ("amount" > 0 AND "change" >= 0);
-- Dinheiro: recebido >= valor e troco = recebido - valor. Demais métodos: sem recebido e troco zero.
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_check" CHECK (CASE WHEN "method" = 'CASH'
  THEN "received_amount" IS NOT NULL AND "received_amount" >= "amount" AND "change" = "received_amount" - "amount"
  ELSE "received_amount" IS NULL AND "change" = 0 END);
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference_check" CHECK ("reference" IS NULL OR (btrim("reference") <> '' AND char_length("reference") <= 60));

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount" > 0);
-- Estorno em dinheiro sai de um caixa (o de quem cancela); PIX/cartão é devolução manual, sem caixa.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cash_session_check" CHECK (("method" = 'CASH') = ("cash_session_id" IS NOT NULL));

-- Índice único PARCIAL (Prisma não representa): no máximo um caixa OPEN por operador e filial.
-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_open_per_operator_key" ON "cash_sessions"("tenant_id", "branch_id", "opened_by") WHERE "status" = 'OPEN';

-- Imutabilidade financeira (defesa em profundidade, além da aplicação; vale também para o dono das tabelas).
-- Pagamentos, estornos e movimentos são append-only: UPDATE/DELETE (por linha) e TRUNCATE (por statement) rejeitados.
-- A mesma função guarda o TRUNCATE de cash_sessions. Sempre lança; nunca retorna normalmente.
-- CreateFunction
CREATE FUNCTION "forbid_financial_record_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial records are never changed or deleted: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING HINT = 'Payments, refunds and cash movements are append-only; a closed cash session is final.';
END;
$$;

-- Insert de pagamento/estorno/movimento só em caixa OPEN (lido FOR SHARE: espera um fechamento em andamento, que trava
-- o caixa FOR UPDATE, e relê o status depois do commit). Pagamento só durante a confirmação (pedido EDITING); estorno só
-- durante o cancelamento de pedido confirmado (nem EDITING nem CANCELLED). Linha inexistente segue para a FK.
-- CreateFunction
CREATE FUNCTION "check_financial_record_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  session_status cash_session_status;
  current_order_status order_status;
BEGIN
  IF NEW.cash_session_id IS NOT NULL THEN
    SELECT s.status INTO session_status FROM cash_sessions s
    WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id AND s.id = NEW.cash_session_id FOR SHARE;
    IF session_status IS NOT NULL AND session_status <> 'OPEN' THEN
      RAISE EXCEPTION 'cash session is closed: INSERT on %.% requires an OPEN cash session', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'payments' THEN
    SELECT o.status INTO current_order_status FROM orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.branch_id = NEW.branch_id AND o.id = NEW.order_id FOR SHARE;
    IF current_order_status IS NOT NULL AND current_order_status <> 'EDITING' THEN
      RAISE EXCEPTION 'payments are recorded only while confirming an EDITING order (current: %)', current_order_status;
    END IF;
  ELSIF TG_TABLE_NAME = 'refunds' THEN
    SELECT o.status INTO current_order_status FROM orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.branch_id = NEW.branch_id AND o.id = NEW.order_id FOR SHARE;
    IF current_order_status IN ('EDITING', 'CANCELLED') THEN
      RAISE EXCEPTION 'refunds are recorded only while cancelling a confirmed order (current: %)', current_order_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Caixa: DELETE sempre rejeitado; depois de CLOSED nada muda; enquanto OPEN, filial, operador, abertura e fundo nunca
-- mudam e a única transição é OPEN -> CLOSED (campos de fechamento exigidos pelo CHECK cash_sessions_closing_check).
-- tenant_id fica com o trigger cash_sessions_tenant_id_immutable.
-- CreateFunction
CREATE FUNCTION "forbid_cash_session_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash sessions are never deleted: DELETE on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'cash session is closed: a CLOSED cash session never changes';
  END IF;
  IF (NEW.id, NEW.branch_id, NEW.opened_by, NEW.opened_at, NEW.opening_amount, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.branch_id, OLD.opened_by, OLD.opened_at, OLD.opening_amount, OLD.created_at) THEN
    RAISE EXCEPTION 'cash session is immutable: id, branch_id, opened_by, opened_at, opening_amount and created_at never change';
  END IF;
  RETURN NEW;
END;
$$;

-- CreateTrigger
CREATE TRIGGER "payments_append_only" BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION "forbid_financial_record_mutation"();
-- CreateTrigger
CREATE TRIGGER "payments_no_truncate" BEFORE TRUNCATE ON "payments" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_financial_record_mutation"();
-- CreateTrigger
CREATE TRIGGER "payments_insert_guard" BEFORE INSERT ON "payments" FOR EACH ROW EXECUTE FUNCTION "check_financial_record_insert"();
-- CreateTrigger
CREATE TRIGGER "refunds_append_only" BEFORE UPDATE OR DELETE ON "refunds" FOR EACH ROW EXECUTE FUNCTION "forbid_financial_record_mutation"();
-- CreateTrigger
CREATE TRIGGER "refunds_no_truncate" BEFORE TRUNCATE ON "refunds" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_financial_record_mutation"();
-- CreateTrigger
CREATE TRIGGER "refunds_insert_guard" BEFORE INSERT ON "refunds" FOR EACH ROW EXECUTE FUNCTION "check_financial_record_insert"();
-- CreateTrigger
CREATE TRIGGER "cash_movements_append_only" BEFORE UPDATE OR DELETE ON "cash_movements" FOR EACH ROW EXECUTE FUNCTION "forbid_financial_record_mutation"();
-- CreateTrigger
CREATE TRIGGER "cash_movements_no_truncate" BEFORE TRUNCATE ON "cash_movements" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_financial_record_mutation"();
-- CreateTrigger
CREATE TRIGGER "cash_movements_insert_guard" BEFORE INSERT ON "cash_movements" FOR EACH ROW EXECUTE FUNCTION "check_financial_record_insert"();
-- CreateTrigger
CREATE TRIGGER "cash_sessions_close_once" BEFORE UPDATE OR DELETE ON "cash_sessions" FOR EACH ROW EXECUTE FUNCTION "forbid_cash_session_mutation"();
-- CreateTrigger
CREATE TRIGGER "cash_sessions_no_truncate" BEFORE TRUNCATE ON "cash_sessions" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_financial_record_mutation"();

-- tenant_id imutável (função compartilhada criada em 20261002120000_make_tenant_id_immutable). Em payments, refunds e
-- cash_movements ele é redundante com o append-only (que dispara antes, por ordem alfabética), mas fica pela regra geral.

-- CreateTrigger
CREATE TRIGGER "cash_sessions_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "cash_sessions"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "cash_movements_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "cash_movements"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "payments_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "payments"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "refunds_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "refunds"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();
