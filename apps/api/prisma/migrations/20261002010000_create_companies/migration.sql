-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT NOT NULL,
    "cnpj" TEXT NOT NULL,
    "status" "company_status" NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "companies" ADD CONSTRAINT "companies_cnpj_check" CHECK ("cnpj" ~ '^[0-9]{14}$');
ALTER TABLE "companies" ADD CONSTRAINT "companies_legal_name_check" CHECK (btrim("legal_name") <> '');
ALTER TABLE "companies" ADD CONSTRAINT "companies_trade_name_check" CHECK (btrim("trade_name") <> '');

-- CreateIndex
CREATE INDEX "companies_tenant_id_idx" ON "companies"("tenant_id");

-- CreateIndex
CREATE INDEX "companies_tenant_id_status_idx" ON "companies"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "companies_tenant_id_cnpj_key" ON "companies"("tenant_id", "cnpj");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
