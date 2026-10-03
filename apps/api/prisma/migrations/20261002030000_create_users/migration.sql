-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "employee_number" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "user_status" NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "users" ADD CONSTRAINT "users_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_employee_number_check" CHECK (btrim("employee_number") <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_password_hash_check" CHECK (btrim("password_hash") <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_attempts_check" CHECK ("failed_login_attempts" >= 0);

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_employee_number_key" ON "users"("tenant_id", "employee_number");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
