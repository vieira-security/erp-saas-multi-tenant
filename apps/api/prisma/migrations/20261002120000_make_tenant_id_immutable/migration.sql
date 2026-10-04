-- tenant_id é imutável: depois de criada, uma linha de tenant nunca muda de tenant (Prisma, SQL ou qualquer ferramenta).
-- Função ÚNICA, compartilhada por todas as tabelas de tenant EDITÁVEIS; não conhece nomes de tabela (usa TG_TABLE_NAME).
-- audit_logs NÃO recebe este trigger: já é append-only (trigger audit_logs_append_only bloqueia qualquer UPDATE).
-- Toda nova tabela de tenant editável precisa do trigger <tabela>_tenant_id_immutable (exigido pela auditoria do catálogo).
-- Funções/triggers não aparecem no schema Prisma e o `migrate diff` os ignora: só os testes de catálogo os protegem.

-- CreateFunction
CREATE FUNCTION "forbid_tenant_id_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Rechecagem defensiva: o WHEN do trigger já filtra, mas a função continua correta se usada sem ele.
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable: UPDATE on %.% cannot change tenant_id', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = 'tenant_id',
            HINT = 'A row never moves to another tenant; create a new row in the target tenant instead.';
  END IF;
  RETURN NEW;
END;
$$;

-- CreateTrigger
CREATE TRIGGER "companies_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "companies"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "branches_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "branches"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "users_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "users"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "user_branch_access_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "user_branch_access"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "roles_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "roles"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "role_permissions_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "role_permissions"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "user_roles_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "user_roles"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "devices_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "devices"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();

-- CreateTrigger
CREATE TRIGGER "sessions_tenant_id_immutable"
BEFORE UPDATE OF "tenant_id" ON "sessions"
FOR EACH ROW WHEN (OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id")
EXECUTE FUNCTION "forbid_tenant_id_change"();
