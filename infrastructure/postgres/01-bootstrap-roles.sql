-- 01 — Roles PostgreSQL do ERP (nível de cluster). Ver infrastructure/postgres/README.md.
--
-- Executar UMA vez por cluster, pela identidade administrativa/bootstrap (superusuário self-hosted ou master do RDS):
--   psql "<conexão admin>" --single-transaction -v ON_ERROR_STOP=1 -f 01-bootstrap-roles.sql
--
-- Cria as duas identidades da aplicação SEM senha: a credencial de login é provisionada fora do git
-- (ALTER ROLE ... PASSWORD a partir de um cofre de segredos, ou IAM database authentication; mecanismo de produção TBD).
--
--   erp_migrator  identidade de migration/deploy; dona de todos os objetos da aplicação; nunca usada pela API/workers.
--   erp_app       identidade runtime da API/workers; não é dona de nada; só os grants explícitos de 03-runtime-grants.sql.
--
-- Idempotente e fail-closed: role existente NÃO é alterada (mudar SUPERUSER/REPLICATION/BYPASSRLS exige superusuário
-- real, indisponível no RDS); o script aborta se uma role existente tiver atributo ou associação proibidos.
-- Compatível com RDS: nenhuma opção exclusiva de superusuário é pedida (as formas NO... são aceitas para CREATEROLE).

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['erp_migrator', 'erp_app'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', name);
    ELSIF EXISTS (
      SELECT FROM pg_roles
      WHERE rolname = name
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)
    ) THEN
      RAISE EXCEPTION 'role % existe com atributos não permitidos (esperado LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS)', name;
    END IF;
  END LOOP;

  -- A identidade runtime nunca alcança os privilégios do migrator (sem membership, sem SET ROLE), e nenhuma das
  -- duas pertence a outra role (ex.: rds_superuser, pg_write_all_data).
  IF EXISTS (
    SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
    WHERE r.rolname IN ('erp_migrator', 'erp_app')
  ) THEN
    RAISE EXCEPTION 'erp_migrator/erp_app não podem ser membros de nenhuma role';
  END IF;
END
$$;
