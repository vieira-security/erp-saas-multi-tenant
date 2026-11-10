-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "refresh_token_hash" TEXT NOT NULL,
    "ip_address" INET,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint (não representáveis no schema Prisma; ver docs/database.md)
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_refresh_token_hash_check" CHECK (btrim("refresh_token_hash") <> '');
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expires_at_check" CHECK ("expires_at" > "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_idx" ON "sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_device_id_idx" ON "sessions"("tenant_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_id_key" ON "devices"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
