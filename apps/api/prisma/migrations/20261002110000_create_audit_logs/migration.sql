-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "branch_id" UUID,
    "device_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "metadata" JSONB,
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_resource_type_check" CHECK ("resource_type" ~ '^[a-z][a-z0-9_]*$');

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_user_id_created_at_idx" ON "audit_logs"("tenant_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_branch_id_created_at_idx" ON "audit_logs"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_device_id_created_at_idx" ON "audit_logs"("tenant_id", "device_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_resource_type_resource_id_created_at_idx" ON "audit_logs"("tenant_id", "resource_type", "resource_id", "created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey (MATCH SIMPLE, padrão do PostgreSQL: verificada só quando user_id não é NULL)
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey (MATCH SIMPLE: verificada só quando branch_id não é NULL)
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey (MATCH SIMPLE: verificada só quando device_id não é NULL)
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- resource_id: referência lógica/polimórfica, intencionalmente SEM FK (ver docs/database.md).
