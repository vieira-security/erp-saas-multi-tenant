-- 03 — Privilégios runtime de erp_app (matriz exata). Ver infrastructure/postgres/README.md e docs/database.md.
--
-- Executar como erp_migrator (dono dos objetos) depois de TODO `prisma migrate deploy`, no mesmo passo do pipeline:
--   psql "<conexão erp_migrator>" --single-transaction -v ON_ERROR_STOP=1 -f 03-runtime-grants.sql
--
-- Idempotente e fail-closed: tudo é revogado e depois concedido explicitamente, numa única transação, então o resultado
-- é exatamente este arquivo. Uma tabela nova NÃO recebe privilégio runtime até ser incluída aqui (e em
-- RUNTIME_TABLE_PRIVILEGES da auditoria estrutural, que falha para tabela sem política declarada).
-- Nunca GRANT ALL, e nunca default privileges de tabela: cada tabela declara sua política.

-- Funções: sem EXECUTE implícito. Funções de trigger rodam quando o trigger dispara; quem dispara não precisa de EXECUTE.
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM erp_app;

-- Tabelas: zera (inclusive grants por coluna) e aplica a matriz explícita.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM erp_app;

-- Entidades mutáveis: sem DELETE (desativação por status), sem TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON tenants, companies, branches, users, roles, devices, sessions TO erp_app;

-- Tabelas de vínculo: alteradas por delete + create, nunca por update.
GRANT SELECT, INSERT, DELETE ON user_branch_access, role_permissions, user_roles TO erp_app;

-- Catálogo técnico global: mantido pelo deploy (seed como erp_migrator); somente leitura em runtime.
GRANT SELECT ON permissions TO erp_app;

-- Trilha de auditoria: append-only também na camada de privilégios (independente dos triggers audit_logs_*).
GRANT SELECT, INSERT ON audit_logs TO erp_app;

-- _prisma_migrations: sem acesso runtime (coberto pelo REVOKE acima).
