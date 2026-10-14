-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "branch_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (índices únicos parciais: não representáveis no schema Prisma; ver docs/database.md)
-- Escopo do tenant (branch_id NULL): uma role global por usuário, sem que NULL fure a unicidade.
CREATE UNIQUE INDEX "user_roles_tenant_scope_key" ON "user_roles"("tenant_id", "user_id", "role_id") WHERE "branch_id" IS NULL;
-- Escopo de filial: uma vez por usuário, role e filial.
CREATE UNIQUE INDEX "user_roles_branch_scope_key" ON "user_roles"("tenant_id", "user_id", "role_id", "branch_id") WHERE "branch_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_user_id_branch_id_idx" ON "user_roles"("tenant_id", "user_id", "branch_id");

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_role_id_idx" ON "user_roles"("tenant_id", "role_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_user_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "user_id", "branch_id") REFERENCES "user_branch_access"("tenant_id", "user_id", "branch_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
