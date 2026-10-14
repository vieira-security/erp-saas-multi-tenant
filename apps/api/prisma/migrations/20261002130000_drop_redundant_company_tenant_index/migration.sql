-- companies_tenant_id_idx (tenant_id) é redundante (M1.14.3): companies_tenant_id_status_idx (tenant_id, status),
-- companies_tenant_id_cnpj_key (tenant_id, cnpj) e companies_tenant_id_id_key (tenant_id, id) já têm tenant_id como
-- primeira coluna e cobrem a FK companies_tenant_id_fkey e as consultas por tenant. Nenhuma constraint ou FK o usa
-- (pg_depend/conindid vazios). Não altera ACL nem ownership.

-- DropIndex
DROP INDEX "companies_tenant_id_idx";
