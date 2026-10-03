# Decisões pendentes (TBD)

Registro único dos pontos em aberto. Resolver antes de implementar o módulo afetado.

| # | Tema | Documento | Bloqueia |
|---|---|---|---|
| 1 | ~~Geração de UUIDv7~~ **Resolvido:** Prisma `@default(uuid(7))`, coluna `uuid` (M1.1) | database | — |
| 2 | Precisão/escala de `numeric` monetário | database | products/payments |
| 3 | Estratégia de remoção por entidade (sem soft delete universal). Já definido: Company sem soft delete, desativação via `status = INACTIVE`, FK Tenant→Company `RESTRICT`; Branch igual (sem soft delete, `INACTIVE`, FKs `RESTRICT`). Em aberto: demais entidades e se Tenant pode ser apagado fisicamente | database | primeiros models |
| 4 | Desenho de idempotency keys (escopo, retenção) | database/offline-edge | offline-sync/orders |
| 5 | Autenticação, sessões, expiração offline | security | auth |
| 6 | Modelo de roles/permissions e fronteiras entre módulos | architecture/security | users |
| 7 | Transmissão de tenant à sessão do banco para RLS (pool, Prisma) | security | ativação da RLS |
| 8 | Escopo da auditoria (estrutura `audit_logs` criada no M1.13; catálogo de ações, eventos obrigatórios e retenção em aberto) | security | audit |
| 9 | LGPD x imutabilidade física | security | tenants/users |
| 10 | Hipóteses de dispensa/emissão seletiva de documento fiscal | fiscal | fiscal |
| 11 | Provedor fiscal, certificado, contingência, numeração, retenção de XML | fiscal | fiscal |
| 12 | Operações permitidas offline (cartão, NFC-e, cancelamento) | offline-edge | PDV offline |
| 13 | Reconciliação/conflitos; protocolos PDV↔Edge↔Cloud | offline-edge | offline-sync/Edge |
| 14 | Impressoras/protocolos suportados; falha de impressão | printing | printing |
| 15 | Provedor de billing | architecture | subscriptions |
| 16 | Ferramenta de incidentes; definição/SLAs de P1–P4 | deployment | admin |
| 17 | Ferramentas de teste de integração, responsividade e load | testing-strategy | primeiras features |
| 18 | CI, ambientes, deploy gradual, observabilidade, backup | deployment | primeiro deploy |
| 19 | Ordem de entrega dentro do MVP | product | planejamento |
| 20 | Regras de comanda, caixa, pagamentos, permissões, trial/assinatura | business-rules | respectivos módulos |

## Contradições e riscos identificados
- **Soft delete x imutabilidade x LGPD:** sem soft delete universal e sem remoção física de vendas/fiscal/auditoria, conflita com pedidos de eliminação de dados pessoais (#9).
- **Offline x fiscal/pagamento:** NFC-e exige numeração e comunicação com a SEFAZ; cartão exige autorização. "Offline parcial" precisa definir o que funciona sem internet (#11, #12).
- **Tenant do frontend x offline/Edge:** o tenant deve vir de credencial de dispositivo/sessão, nunca de input livre; a expiração dessa credencial offline é um dilema (#5).
- **RLS + Prisma + pool:** a RLS exige contexto por transação/conexão, que o Prisma não faz nativamente; adiar a RLS não deve levar a um schema que a impeça (#7).
- **UUIDv7:** revela o instante de criação; aceitável para IDs internos, mas avaliar em IDs expostos a terceiros. Gerado só pelo Prisma Client: SQL bruto/ferramentas externas precisam informar o `id` (PostgreSQL < 18 não tem `uuidv7()` nativo).
- **Fuso da sessão x `@prisma/adapter-pg`:** o adapter presume sessão em UTC; `createPrismaClient` fixa `TimeZone=UTC` via parâmetro de startup. Poolers que rejeitam parâmetros de startup (ex.: PgBouncer em modo transação, RDS Proxy) exigirão outra forma de garantir UTC — validar antes de adotar pooler ([database.md](database.md)).
- **Company.timezone sem validação:** o banco aceita qualquer texto (sem lista própria de fusos, por decisão). Um valor inválido só falhará quando usado (ex.: `AT TIME ZONE`); a validação IANA deve entrar na camada de aplicação junto com o primeiro endpoint/serviço de Company.
- **CNPJ:** só formato (14 dígitos) é garantido; dígitos verificadores e unicidade global ficam para etapa posterior.
- **CHECKs, funções e triggers fora do schema Prisma:** não aparecem em `migrate diff`; dependem de testes explícitos de catálogo e de cuidado em migrations futuras ([database.md](database.md)).
- **PostgreSQL 17 x 18:** a versão de validação é **PostgreSQL 17.x**. Num PostgreSQL 18 parte da suíte falha sem relação com o schema: a mensagem de violação de FK `RESTRICT` mudou (`violates RESTRICT setting of foreign key constraint`) e `pg_constraint` passou a listar constraints `NOT NULL` (quebra os testes que comparam a lista completa de constraints). A compatibilidade com o 18 deve ser revisada em tarefa separada, sem migrar o projeto agora. Diretriz: testes não devem depender do texto exato de mensagens de erro do PostgreSQL quando houver alternativa estrutural melhor (SQLSTATE, nome da constraint, consulta ao catálogo filtrando por `contype`). O servidor de teste também deve usar encoding `UTF8` (um cluster `WIN1252` quebra os testes de CNPJ com dígitos não ASCII).
- **Índice `companies(tenant_id)` redundante:** `(tenant_id, status)`, a unique `(tenant_id, cnpj)` e a unique `(tenant_id, id)` (M1.3) já começam por `tenant_id`; mantido por decisão do M1.2, candidato a remoção.
- ~~Imutabilidade de `tenant_id` não imposta por completo~~ **Resolvido no M1.14.1:** `tenant_id` é imutável no banco para toda entidade editável de tenant (trigger por tabela + `forbid_tenant_id_change()`); `audit_logs` é coberta pelo append-only. Risco residual: o trigger é `UPDATE OF tenant_id` (não pega um eventual trigger futuro que altere `NEW.tenant_id` sem a coluna no `SET`) e papéis privilegiados podem desabilitar triggers (#7).
- **CNPJ de Branch x Company:** não há relação validada entre o CNPJ da filial e o da empresa (raiz/matriz), nem unicidade entre as duas tabelas. Validação completa (dígitos verificadores, raiz) será de `packages/validation`.
- **Branch.timezone e Branch.code:** timezone sem validação IANA no banco (validação na aplicação); code sem normalização, então `MORUMBI` e `morumbi` são códigos distintos até a aplicação aplicar trim + uppercase.
- **Roles por filial:** `UserBranchAccess` não carrega papel; roles/permissions (globais ou por filial) e sua relação com o acesso à filial ainda serão modeladas (#6).
- **Roles padrão:** `OWNER`, `MANAGER`, `ATTENDANT`, `KITCHEN` não são reservados no banco (uma role customizada pode usar o código se ele estiver livre no tenant) e não há provisionamento ainda. Definir no provisionamento do Tenant: criação das quatro roles, se os códigos são reservados e quais regras protegem roles `is_system` (edição, arquivamento).
- **Constantes de códigos de role:** não foram criadas em `packages/contracts` porque os packages ainda não têm estratégia de build/consumo pela api; decidir junto com o primeiro uso compartilhado.
- **Catálogo de permissões:** o seed não remove permissões que saírem do catálogo (remoção/renomeação exigirá migração dedicada considerando RolePermission). Execução do seed no pipeline de deploy ainda não definida (#18). Nomes do catálogo inicial são provisórios até os módulos correspondentes existirem.

- **Worker x tenant:** jobs assíncronos também precisam de tenant context explícito, inclusive os disparados por n8n via API.
- **Rollback x migrations destrutivas:** rollback de código só é seguro com migrations retrocompatíveis.
- **Edge "premium" x dados mínimos:** a definição de "dados mínimos" afeta suporte, segurança do dispositivo local e LGPD.
- **Escopo do MVP extenso:** 12 prioridades, incluindo fiscal e offline, sem ordem de entrega definida (#19).
- **Branch base:** esta documentação foi escrita sobre `chore/install-core-frameworks`, ainda não mergeada.

## Pendências do RolePermission originadas no M1.8
1. ~~Modelo de RolePermission e auditoria de FK para tabela global~~ **Resolvido no M1.9.**
2. Quais permissões cada role padrão recebe no provisionamento (OWNER, MANAGER, ATTENDANT, KITCHEN).
3. Política para permissão removida/renomeada do catálogo com vínculos existentes (`RESTRICT`).
4. Escopo por filial das permissões/roles (#6).

## Pendências do hardening M1.14 (M1.14.2+)
1. ~~Impor `tenant_id` imutável no banco~~ **Resolvido no M1.14.1** (migration `20261002120000_make_tenant_id_immutable`): função `forbid_tenant_id_change()` e triggers `<tabela>_tenant_id_immutable` nas 9 tabelas editáveis; os 10 testes `GAP (M1.14)` foram invertidos; auditoria do catálogo exige o trigger (derivado da classificação, com `audit_logs` como política append-only explícita); inventário de funções/triggers atualizado.
2. **Proteção contra `new PrismaClient()` além do lint:** avaliar se a regra ESLint basta (não cobre `import()` dinâmico nem indireção).
3. **Índices candidatos a remoção:** `companies_tenant_id_idx` (coberto por `(tenant_id, status)`, `(tenant_id, cnpj)` e `(tenant_id, id)`). Remover só com migration dedicada e revisão.
4. **Normalização de `Branch.code`** (trim + uppercase) na aplicação; avaliar unique por `(tenant_id, upper(code))` no banco.
5. **Validações em `packages/validation`:** CNPJ completo (dígitos verificadores, raiz Branch x Company) e timezone IANA.
6. ~~TRUNCATE em `audit_logs`~~ **Resolvido no M1.14.2a** (migration `20261002121000_forbid_audit_logs_truncate`).
7. **M1.14.2b — modelo de privilégios do PostgreSQL:** as proteções por trigger (append-only de `audit_logs`, imutabilidade de `tenant_id`) valem com triggers ativos e não resistem a superusuário/dono da tabela (`DISABLE TRIGGER`, `session_replication_role`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER`, `DROP TABLE`). Definir papel de migração (dono) separado do papel da aplicação (sem ownership, sem superusuário, sem `TRUNCATE`/`UPDATE`/`DELETE` em `audit_logs`), GRANT/REVOKE e o equivalente no RDS (#7, #18).

## Pendências de dispositivos (M2/Edge) originadas no M1.11
1. Autenticação/pairing de dispositivo, credencial e armazenamento seguro de segredos (módulo próprio, nunca em texto puro).
2. Geração e formato de `device_key`; normalização.
3. Efeito de `REVOKED`/`INACTIVE` em sessões e operações; heartbeat e atualização de `last_seen_at`.
4. Se um dispositivo pode mudar de filial e se `ADMIN`/`EDGE` exigem ou proíbem `branch_id` (hoje livre).

## Pendências da autorização (M2) originadas no M1.10
1. Semântica de resolução: role global vale em todas as filiais? Como combinar global + específica (redundância, precedência) e roles de status `INACTIVE`/`ARCHIVED` ou usuário `DISABLED`/`LOCKED`.
2. Se trocar `role_id`/`branch_id` de um UserRole dentro do tenant deve ser proibido no banco (hoje aceito; fluxo previsto é delete + create).
3. Revogar UserBranchAccess com roles escopadas exige remover as roles antes (`RESTRICT`); definir o fluxo administrativo.

## Pendências do AuditService originadas no M1.13
1. ~~Impor append-only no banco~~ **Resolvido no M1.13.1** (trigger `audit_logs_append_only`); ~~bloquear `TRUNCATE`~~ **resolvido no M1.14.2a** (trigger `audit_logs_no_truncate`). Restam (M1.14.2b): revogar `UPDATE`/`DELETE`/`TRUNCATE` do papel da aplicação e garantir que ele não seja dono das tabelas nem superusuário, para que não possa desabilitar/remover triggers ou alterar funções (estratégia de papéis, #7); como conciliar com remoção exigida por LGPD (#9), que hoje exigiria desabilitar o trigger em operação administrativa controlada.
2. **Sanitização de `metadata`:** filtro/máscara de credenciais e dados sensíveis (senha, hashes, tokens, segredos, chaves, PIN, cartão) antes de gravar; preferir allowlist de campos por ação. Limite de tamanho e forma (ex.: só objeto JSON) ainda não definidos.
3. **Catálogo de ações e de `resource_type`:** onde fica (constantes em `packages/contracts`?), quais eventos são obrigatórios por módulo (#8) e se o banco deve validar contra um catálogo.
4. **Instrumentação:** quais controllers/services/workers gravam, na mesma transação da operação ou de forma assíncrona; origem de `ip_address` atrás de proxy/load balancer.
5. **Retenção e volume:** política de retenção, particionamento por tempo, arquivamento; LGPD de `ip_address` e de dados pessoais em `metadata` (#9).
6. **Leitura:** quem pode consultar a trilha (permissão no catálogo, ex.: `audit.read`) e se há exportação.

## Pendências do M2 (Auth) originadas no M1.12
1. Geração do refresh token (entropia), algoritmo de hash e comparação; duração de `expires_at`.
2. Rotação transacional do `refresh_token_hash`; proteção contra replay/reuso (histórico, token family, hash anterior) se necessária.
3. Revogação: logout, encerramento administrativo, revogação ao desativar/bloquear usuário ou revogar dispositivo.
4. Limpeza/retenção de sessões expiradas e revogadas; LGPD de `ip_address`/`user_agent` (#9).
5. Se a CHECK `expires_at > created_at` atrapalhar importações/backfills, revisar.

## Pendências do M2 (Auth) originadas no M1.5
1. Algoritmo e parâmetros de hashing (previsão Argon2id) e formato do `password_hash`.
2. Regras de transição de `status` e coerência com `disabled_at`/`locked_until` (inclusive reativação e bloqueio sem prazo).
3. Lockout/throttling: uso de `failed_login_attempts` e `locked_until`; atualização de `last_login_at`.
4. Fluxo de credencial temporária/reset administrativo com `must_change_password`, sem guardar senha temporária em texto.
5. Normalização da matrícula (trim/caixa) antes de gravar e no login.
6. LGPD: `users.name` é dado pessoal e o usuário não é apagado fisicamente (#9).

## Antes do Prompt 3
Mínimo recomendado: #1, #3, #5, #6 e #7 (fundação de IDs, remoção, auth e tenant context), mais #19 para definir qual módulo vem primeiro.
