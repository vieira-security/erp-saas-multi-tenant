-- M4: produtos e cardápio (cardápio único por tenant + ajuste por filial; grupos de opções para variação/adicional/combo).
-- Todas as tabelas são de tenant: tenant_id uuid NOT NULL, FK direta para tenants e FKs COMPOSTAS (tenant_id, x_id)
-- para os pais, sempre ON DELETE/UPDATE RESTRICT (sem CASCADE). Dinheiro em numeric(12,2) (reais, nunca float).
-- Campos fiscais (NCM, CFOP, CEST, origem, tributação) NÃO entram aqui: são do M9.
-- CHECKs e triggers não são representáveis no schema Prisma: ficam nesta migration e nos inventários dos testes.
-- Privilégios runtime: infrastructure/postgres/03-runtime-grants.sql.

-- CreateEnum
CREATE TYPE "product_category_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "product_category_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT,
    "base_price" DECIMAL(12,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "product_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_choices" INTEGER NOT NULL,
    "max_choices" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta" DECIMAL(12,2) NOT NULL,
    "linked_product_id" UUID,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_product_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "available" BOOLEAN NOT NULL,
    "price" DECIMAL(12,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_product_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_tenant_id_status_idx" ON "product_categories"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenant_id_id_key" ON "product_categories"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "products_tenant_id_status_idx" ON "products"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "products_tenant_id_category_id_idx" ON "products"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_code_key" ON "products"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_groups_tenant_id_product_id_sort_order_key" ON "product_option_groups"("tenant_id", "product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_groups_tenant_id_product_id_id_key" ON "product_option_groups"("tenant_id", "product_id", "id");

-- CreateIndex
CREATE INDEX "product_options_tenant_id_linked_product_id_idx" ON "product_options"("tenant_id", "linked_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_tenant_id_product_id_group_id_sort_order_key" ON "product_options"("tenant_id", "product_id", "group_id", "sort_order");

-- CreateIndex
CREATE INDEX "branch_product_settings_tenant_id_product_id_idx" ON "branch_product_settings"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_product_settings_tenant_id_branch_id_product_id_key" ON "branch_product_settings"("tenant_id", "branch_id", "product_id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_tenant_id_product_id_group_id_fkey" FOREIGN KEY ("tenant_id", "product_id", "group_id") REFERENCES "product_option_groups"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_tenant_id_linked_product_id_fkey" FOREIGN KEY ("tenant_id", "linked_product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_product_settings" ADD CONSTRAINT "branch_product_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_product_settings" ADD CONSTRAINT "branch_product_settings_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branch_product_settings" ADD CONSTRAINT "branch_product_settings_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 9999);

ALTER TABLE "products" ADD CONSTRAINT "products_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "products" ADD CONSTRAINT "products_description_check" CHECK ("description" IS NULL OR btrim("description") <> '');
-- Mesmo formato de branches.code (BRANCH_CODE_PATTERN): a aplicação faz trim + maiúsculo antes de gravar.
ALTER TABLE "products" ADD CONSTRAINT "products_code_check" CHECK ("code" IS NULL OR "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "products" ADD CONSTRAINT "products_base_price_check" CHECK ("base_price" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 9999);

ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_min_choices_check" CHECK ("min_choices" >= 0);
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_max_choices_check" CHECK ("max_choices" >= 1);
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_choices_check" CHECK ("min_choices" <= "max_choices");
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 9999);

ALTER TABLE "product_options" ADD CONSTRAINT "product_options_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_price_delta_check" CHECK ("price_delta" >= 0);
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 9999);
-- product_id é o produto do grupo (garantido pela FK composta com product_option_groups): a opção não vincula o
-- próprio produto. "Combo não aninha combo" depende de outras linhas e fica na aplicação (com trava de products).
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_linked_product_check" CHECK ("linked_product_id" IS NULL OR "linked_product_id" <> "product_id");

ALTER TABLE "branch_product_settings" ADD CONSTRAINT "branch_product_settings_price_check" CHECK ("price" IS NULL OR "price" >= 0);

-- tenant_id imutável (função compartilhada criada em 20261002120000_make_tenant_id_immutable).

-- CreateTrigger
CREATE TRIGGER "product_categories_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "product_categories"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "products_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "products"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "product_option_groups_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "product_option_groups"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "product_options_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "product_options"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "branch_product_settings_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "branch_product_settings"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();
