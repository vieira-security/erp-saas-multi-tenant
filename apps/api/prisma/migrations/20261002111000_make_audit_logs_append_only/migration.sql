-- AuditLog é append-only: UPDATE e DELETE são bloqueados fisicamente; INSERT continua livre.
-- Função e trigger ESPECÍFICOS de audit_logs (não reutilizar em outras tabelas). Não confundir com o
-- futuro trigger genérico de imutabilidade de tenant_id (M1.14). Funções/triggers não são representáveis
-- no schema Prisma e o `migrate diff` os ignora: só os testes de catálogo os protegem (ver docs/database.md).

-- CreateFunction
CREATE FUNCTION "forbid_audit_log_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % on audit_logs is not allowed', TG_OP
    USING HINT = 'Audit logs can only be inserted; record a new event instead of changing or removing one.';
END;
$$;

-- CreateTrigger
CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "forbid_audit_log_mutation"();
