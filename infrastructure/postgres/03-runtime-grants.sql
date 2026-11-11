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

-- M4, catálogo de produtos (cadastro mestre): sem DELETE (categoria/produto só mudam de status; pedidos futuros
-- guardam cópia de nome/preço), sem TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON product_categories, products TO erp_app;

-- M4, grupos e opções de um produto: substituídos em bloco (DELETE + INSERT na mesma transação), nunca por UPDATE.
GRANT SELECT, INSERT, DELETE ON product_option_groups, product_options TO erp_app;

-- M4, ajuste do produto na filial: upsert (INSERT/UPDATE) e "voltar ao padrão" apaga a linha (DELETE idempotente).
GRANT SELECT, INSERT, UPDATE, DELETE ON branch_product_settings TO erp_app;

-- M5, pedido: criado (INSERT) e movido de estado (UPDATE). Sem DELETE: vendas nunca são apagadas; rascunho descartado
-- vira CANCELLED. O trigger orders_immutable_after_confirmation congela o pedido confirmado mesmo com UPDATE.
GRANT SELECT, INSERT, UPDATE ON orders TO erp_app;

-- M5, itens e opções do pedido: substituídos em bloco (DELETE + INSERT) só em EDITING (garantido também pelos
-- triggers *_editing_only); sem UPDATE e sem TRUNCATE.
GRANT SELECT, INSERT, DELETE ON order_items, order_item_options TO erp_app;

-- M5, contador do número do dia: INSERT ... ON CONFLICT DO UPDATE ... RETURNING (exige INSERT, UPDATE e SELECT).
-- Sem DELETE: o histórico de numeração fica.
GRANT SELECT, INSERT, UPDATE ON branch_order_counters TO erp_app;

-- M6, registros financeiros: append-only também por privilégio (independente dos triggers *_append_only): pagamentos e
-- estornos gravados na confirmação/cancelamento, sangrias e suprimentos. Sem UPDATE, DELETE ou TRUNCATE.
GRANT SELECT, INSERT ON payments, refunds, cash_movements TO erp_app;

-- M6, caixa: aberto (INSERT) e fechado uma única vez (UPDATE, congelado depois pelo trigger cash_sessions_close_once).
-- Sem DELETE nem TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON cash_sessions TO erp_app;

-- M7, setores de preparo do tenant: criados (INSERT), editados/ativados/desativados/trocados de padrão (UPDATE). Sem
-- DELETE (só status), sem TRUNCATE. UPDATE também permite o FOR SHARE/FOR UPDATE das travas da confirmação.
GRANT SELECT, INSERT, UPDATE ON kitchen_sectors TO erp_app;

-- M7, setor ligado/desligado na filial: upsert (INSERT ... ON CONFLICT DO UPDATE). Sem DELETE: desligar e religar só
-- mudam `enabled`. UPDATE também permite o FOR SHARE da confirmação.
GRANT SELECT, INSERT, UPDATE ON branch_kitchen_sectors TO erp_app;

-- M7, comandas: criadas na confirmação (INSERT), movidas de estado/canceladas/impressas (UPDATE). Sem DELETE nem TRUNCATE
-- (comanda nunca é apagada; trigger kitchen_tickets_guard).
GRANT SELECT, INSERT, UPDATE ON kitchen_tickets TO erp_app;

-- M7, itens da comanda: append-only também por privilégio (independente do trigger kitchen_ticket_items_guard).
GRANT SELECT, INSERT ON kitchen_ticket_items TO erp_app;

-- Catálogo técnico global: mantido pelo deploy (seed como erp_migrator); somente leitura em runtime.
GRANT SELECT ON permissions TO erp_app;

-- Trilha de auditoria: append-only também na camada de privilégios (independente dos triggers audit_logs_*).
GRANT SELECT, INSERT ON audit_logs TO erp_app;

-- _prisma_migrations: sem acesso runtime (coberto pelo REVOKE acima).
