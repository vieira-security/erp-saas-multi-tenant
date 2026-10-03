-- CreateEnum
CREATE TYPE "device_type" AS ENUM ('POS', 'TABLET', 'ADMIN', 'KITCHEN_DISPLAY', 'EDGE');

-- CreateEnum
CREATE TYPE "device_status" AS ENUM ('ACTIVE', 'INACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "name" TEXT NOT NULL,
    "device_type" "device_type" NOT NULL,
    "device_key" TEXT NOT NULL,
    "status" "device_status" NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "devices" ADD CONSTRAINT "devices_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "devices" ADD CONSTRAINT "devices_device_key_check" CHECK (btrim("device_key") <> '');

-- CreateIndex
CREATE INDEX "devices_tenant_id_status_idx" ON "devices"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "devices_tenant_id_branch_id_idx" ON "devices"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_device_key_key" ON "devices"("tenant_id", "device_key");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
