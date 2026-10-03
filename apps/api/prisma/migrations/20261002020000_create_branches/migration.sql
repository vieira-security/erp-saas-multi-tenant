-- CreateEnum
CREATE TYPE "branch_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "cnpj" TEXT,
    "status" "branch_status" NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "branches" ADD CONSTRAINT "branches_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "branches" ADD CONSTRAINT "branches_code_check" CHECK (btrim("code") <> '');
ALTER TABLE "branches" ADD CONSTRAINT "branches_cnpj_check" CHECK ("cnpj" IS NULL OR "cnpj" ~ '^[0-9]{14}$');

-- CreateIndex
CREATE INDEX "branches_tenant_id_company_id_idx" ON "branches"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "branches_tenant_id_status_idx" ON "branches"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_code_key" ON "branches"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_cnpj_key" ON "branches"("tenant_id", "cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "companies_tenant_id_id_key" ON "companies"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
