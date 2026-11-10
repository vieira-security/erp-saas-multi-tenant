-- 02 — Privilégios de database/schema do banco do ERP. Ver infrastructure/postgres/README.md.
--
-- Executar UMA vez por banco da aplicação, pela identidade administrativa/bootstrap, conectada a ESSE banco, depois de
-- 01-bootstrap-roles.sql e antes do primeiro `prisma migrate deploy`:
--   psql "<conexão admin ao banco do ERP>" --single-transaction -v ON_ERROR_STOP=1 -f 02-bootstrap-database.sql
--
-- Idempotente. O database continua pertencendo à identidade administrativa: erp_migrator cria objetos só dentro do
-- schema public (sem CREATE no database, portanto sem novos schemas) e erp_app não cria nada.

-- Ninguém cria objetos em public por padrão (já é o padrão desde o PostgreSQL 15; explícito para servidores antigos).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Identidade de migration: cria e é dona dos objetos da aplicação.
GRANT USAGE, CREATE ON SCHEMA public TO erp_migrator;

-- Identidade runtime: resolve objetos em public, nunca os cria.
GRANT USAGE ON SCHEMA public TO erp_app;
REVOKE CREATE ON SCHEMA public FROM erp_app;

-- CONNECT explícito, para que revogar futuramente o CONNECT padrão de PUBLIC não tranque o ERP fora do banco.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO erp_migrator, erp_app', current_database());
END
$$;
