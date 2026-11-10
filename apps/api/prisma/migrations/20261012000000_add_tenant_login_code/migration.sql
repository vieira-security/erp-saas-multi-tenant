-- M2 (decisão de produto): código PÚBLICO da organização que resolve o tenant antes do login.
-- Não é segredo e nunca autentica nem autoriza: só identifica em qual tenant a matrícula é procurada.
-- Único globalmente; formato de digitação (maiúsculas, dígitos e hífen interno, 4-32 caracteres), normalizado pela
-- aplicação (trim + uppercase) antes de gravar e de buscar. Nulo = tenant ainda sem login por código (caminho
-- incremental: tenants existentes não recebem código inventado). Sem default e sem backfill.
-- tenants é raiz (sem tenant_id): não recebe o trigger de imutabilidade de tenant_id. Não altera ACL nem ownership:
-- erp_app já tem SELECT/INSERT/UPDATE em tenants (03-runtime-grants.sql), nenhuma grant nova.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "login_code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_login_code_key" ON "tenants"("login_code");

-- Format (fora do PSL)
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_login_code_check" CHECK ("login_code" ~ '^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$');
