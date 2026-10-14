-- AuditLog também bloqueia TRUNCATE: row triggers (audit_logs_append_only) não disparam em TRUNCATE, que é operação
-- de statement. Reutiliza forbid_audit_log_mutation() SEM alterá-la: ela sempre lança erro e já informa TG_OP, então
-- reporta 'TRUNCATE on audit_logs'. Cobre também TRUNCATE em cascata a partir de tabelas pai (ex.: tenants CASCADE).
-- Não protege contra papel privilegiado que desabilite/remova triggers ou altere a função (M1.14.2b).
-- Funções/triggers não aparecem no schema Prisma e o `migrate diff` os ignora: só os testes de catálogo os protegem.

-- CreateTrigger
CREATE TRIGGER "audit_logs_no_truncate"
BEFORE TRUNCATE ON "audit_logs"
FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_log_mutation"();
