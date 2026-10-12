# Decisões pendentes (TBD)

Registro único dos pontos em aberto. Resolver antes de implementar o módulo afetado.

| # | Tema | Documento | Bloqueia |
|---|---|---|---|
| 1 | ~~Geração de UUIDv7~~ **Resolvido:** Prisma `@default(uuid(7))`, coluna `uuid` (M1.1) | database | — |
| 2 | Precisão/escala de `numeric` monetário | database | products/payments |
| 3 | Estratégia de remoção por entidade (sem soft delete universal). Já definido: Company sem soft delete, desativação via `status = INACTIVE`, FK Tenant→Company `RESTRICT`; Branch igual (sem soft delete, `INACTIVE`, FKs `RESTRICT`). Em aberto: demais entidades e se Tenant pode ser apagado fisicamente | database | primeiros models |
| 4 | Desenho de idempotency keys (escopo, retenção) | database/offline-edge | offline-sync/orders |
| 5 | ~~Autenticação, sessões, transporte, TTLs~~ **resolvido no M2** ([security.md](security.md)); resta a expiração/autenticação offline do PDV | security | PDV offline |
| 6 | ~~Modelo de roles/permissions e matriz padrão~~ **resolvido no M2**; restam fronteiras entre módulos | architecture/security | módulos futuros |
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
- ~~Índice `companies(tenant_id)` redundante~~ **Resolvido no M1.14.3** (migration `20261002130000_drop_redundant_company_tenant_index`).
- ~~Imutabilidade de `tenant_id` não imposta por completo~~ **Resolvido no M1.14.1:** `tenant_id` é imutável no banco para toda entidade editável de tenant (trigger por tabela + `forbid_tenant_id_change()`); `audit_logs` é coberta pelo append-only. Risco residual: o trigger é `UPDATE OF tenant_id` (não pega um eventual trigger futuro que altere `NEW.tenant_id` sem a coluna no `SET`) e o dono dos objetos/identidade admin podem desabilitar triggers (a aplicação, como `erp_app`, não pode desde o M1.14.2b).
- **CNPJ de Branch x Company:** não há relação validada entre o CNPJ da filial e o da empresa (raiz/matriz), nem unicidade entre as duas tabelas. Validação completa (dígitos verificadores, raiz) será de `packages/validation`.
- **Branch.timezone e Branch.code:** timezone sem validação IANA no banco (validação na aplicação); code sem normalização, então `MORUMBI` e `morumbi` são códigos distintos até a aplicação aplicar trim + uppercase.
- ~~**Roles por filial:** roles/permissions por filial e sua relação com o acesso à filial ainda serão modeladas~~ **Resolvido estruturalmente no M1.10:** `user_roles.branch_id` (NULL = tenant inteiro) exige `UserBranchAccess` por FK composta. A semântica de resolução fica para o M2 (ver "Pendências da autorização").
- **Roles padrão:** `OWNER`, `MANAGER`, `ATTENDANT`, `KITCHEN` não são reservados no banco (uma role customizada pode usar o código se ele estiver livre no tenant) e não há provisionamento ainda. Definir no provisionamento do Tenant: criação das quatro roles, se os códigos são reservados e quais regras protegem roles `is_system` (edição, arquivamento).
- **Constantes de códigos de role:** não foram criadas em `packages/contracts` porque os packages ainda não têm estratégia de build/consumo pela api; decidir junto com o primeiro uso compartilhado.
- **Catálogo de permissões:** o seed não remove permissões que saírem do catálogo (remoção/renomeação exigirá migração dedicada considerando RolePermission). Execução do seed no pipeline de deploy ainda não definida (#18). Nomes do catálogo inicial são provisórios até os módulos correspondentes existirem.

- **Worker x tenant:** jobs assíncronos também precisam de tenant context explícito, inclusive os disparados por n8n via API.
- **Rollback x migrations destrutivas:** rollback de código só é seguro com migrations retrocompatíveis.
- **Edge "premium" x dados mínimos:** a definição de "dados mínimos" afeta suporte, segurança do dispositivo local e LGPD.
- **Escopo do MVP extenso:** 12 prioridades, incluindo fiscal e offline, sem ordem de entrega definida (#19).
- **Branch base:** o M1 foi desenvolvido em branches empilhadas a partir de `chore/install-core-frameworks` (até `chore/m1-final-gate`); nenhuma delas está mergeada na `main`, que ainda contém só o bootstrap. A entrada na `main` segue por Pull Request.

## Pendências do RolePermission originadas no M1.8
1. ~~Modelo de RolePermission e auditoria de FK para tabela global~~ **Resolvido no M1.9.**
2. Quais permissões cada role padrão recebe no provisionamento (OWNER, MANAGER, ATTENDANT, KITCHEN).
3. Política para permissão removida/renomeada do catálogo com vínculos existentes (`RESTRICT`).
4. ~~Escopo por filial das permissões/roles (#6)~~ **Resolvido estruturalmente no M1.10** (`user_roles.branch_id`); semântica no M2.

## Pendências do hardening M1.14 (M1.14.2+)
1. ~~Impor `tenant_id` imutável no banco~~ **Resolvido no M1.14.1** (migration `20261002120000_make_tenant_id_immutable`): função `forbid_tenant_id_change()` e triggers `<tabela>_tenant_id_immutable` nas 9 tabelas editáveis; os 10 testes `GAP (M1.14)` foram invertidos; auditoria do catálogo exige o trigger (derivado da classificação, com `audit_logs` como política append-only explícita); inventário de funções/triggers atualizado.
2. ~~**Proteção contra `new PrismaClient()` além do lint**~~ **Avaliado no M1.14.4, não bloqueante:** o ESLint rejeita `new PrismaClient()`, import de valor com ou sem alias e import de namespace (`import * as`); escapam só `import()` dinâmico e `require`, que exigem intenção explícita e aparecem em review. O impacto de um bypass é a sessão sem `TimeZone=UTC` (instantes deslocados), não isolamento nem privilégio: a identidade e os grants vêm da `DATABASE_URL` (`erp_app`), não da factory. Melhoria opcional, sem dependência nova: acrescentar a `no-restricted-syntax` o seletor `ImportExpression[source.value=/generated.prisma/]` fora de `create-prisma-client.ts` (verificado: pega o `import()` do client gerado e não afeta outros imports dinâmicos; não cobre `require`).
3. ~~Índices candidatos a remoção~~ **Resolvido no M1.14.3:** `companies_tenant_id_idx` removido; nenhum outro índice estruturalmente redundante; todas as FKs cobertas por índice; auditoria de índices/CHECKs/índices parciais em `schema-hardening.int.test.ts`. Revisão de índices por workload (ex.: `audit_logs`, `sessions.expires_at`) só com uso real.
4. **Normalização de `Branch.code`** (trim + uppercase) na aplicação; avaliar unique por `(tenant_id, upper(code))` no banco.
5. **Validações em `packages/validation`:** CNPJ completo (dígitos verificadores, raiz Branch x Company) e timezone IANA.
6. ~~TRUNCATE em `audit_logs`~~ **Resolvido no M1.14.2a** (migration `20261002121000_forbid_audit_logs_truncate`).
7. ~~M1.14.2b — modelo de privilégios do PostgreSQL~~ **Resolvido no M1.14.2b:** `erp_migrator` (dono, só deploy) e `erp_app` (runtime, sem ownership, matriz explícita, sem `UPDATE`/`DELETE`/`TRUNCATE` em `audit_logs`, sem `EXECUTE` nas funções de proteção, sem `CREATE` em `public`), scripts em `infrastructure/postgres/` e auditoria fail-closed. Restam: (a) mecanismo de login em produção (Secrets Manager ou IAM database authentication); (b) o dono e a identidade admin continuam capazes de desabilitar triggers/alterar funções/DDL — mitigação operacional, avaliar auditoria do próprio pipeline (ex.: `pgaudit`, logs do RDS); (c) avaliar revogar `TEMPORARY`/`CONNECT` padrão de `PUBLIC` no database; (d) conexão de workers/n8n e pool/proxy (RDS Proxy) com `erp_app`; (e) integração com RLS (#7).

## Pendências de dispositivos (M2/Edge) originadas no M1.11
1. Autenticação/pairing de dispositivo, credencial e armazenamento seguro de segredos (módulo próprio, nunca em texto puro).
2. Geração e formato de `device_key`; normalização.
3. Efeito de `REVOKED`/`INACTIVE` em sessões e operações; heartbeat e atualização de `last_seen_at`.
4. Se um dispositivo pode mudar de filial e se `ADMIN`/`EDGE` exigem ou proíbem `branch_id` (hoje livre).

## Pendências da autorização (M2) originadas no M1.10
1. ~~Semântica de resolução~~ **Resolvido no M2.9:** role tenant-wide vale no tenant e em toda filial; role de filial só na filial; união sem precedência; só role `ACTIVE` e usuário `ACTIVE` concedem. `UserBranchAccess` obrigatório em escopo de filial (decidido no gate).
2. Se trocar `role_id`/`branch_id` de um UserRole dentro do tenant deve ser proibido no banco (hoje aceito; fluxo previsto é delete + create).
3. Revogar UserBranchAccess com roles escopadas exige remover as roles antes (`RESTRICT`); definir o fluxo administrativo.

## Pendências do AuditService originadas no M1.13
1. ~~Impor append-only no banco~~ **Resolvido no M1.13.1** (trigger `audit_logs_append_only`); ~~bloquear `TRUNCATE`~~ **resolvido no M1.14.2a** (trigger `audit_logs_no_truncate`). ~~revogar `UPDATE`/`DELETE`/`TRUNCATE` do papel da aplicação e garantir que ele não seja dono~~ **resolvido no M1.14.2b** (`erp_app`). Resta: como conciliar com remoção exigida por LGPD (#9), que hoje exigiria desabilitar o trigger em operação administrativa controlada.
2. **Sanitização de `metadata`:** filtro/máscara de credenciais e dados sensíveis (senha, hashes, tokens, segredos, chaves, PIN, cartão) antes de gravar; preferir allowlist de campos por ação. Limite de tamanho e forma (ex.: só objeto JSON) ainda não definidos.
3. **Catálogo de ações e de `resource_type`:** onde fica (constantes em `packages/contracts`?), quais eventos são obrigatórios por módulo (#8) e se o banco deve validar contra um catálogo.
4. **Instrumentação:** quais controllers/services/workers gravam, na mesma transação da operação ou de forma assíncrona; origem de `ip_address` atrás de proxy/load balancer.
5. **Retenção e volume:** política de retenção, particionamento por tempo, arquivamento; LGPD de `ip_address` e de dados pessoais em `metadata` (#9).
6. **Leitura:** quem pode consultar a trilha (permissão no catálogo, ex.: `audit.read`) e se há exportação.

## Decisões do M2 (fechamento) e itens futuros
**Decididas e implementadas** ([security.md](security.md)): descoberta do tenant por código público de login (`tenants.login_code`); access token em memória via Bearer + refresh em cookie HttpOnly/Secure/SameSite=Strict/Path=/auth com checagem de `Origin`; matriz das roles padrão (OWNER = 19 permissões atuais, sem permissões futuras automáticas); matrícula normalizada (trim + uppercase, zeros à esquerda preservados, `[A-Z0-9._-]`, 1–32); access token 15 min e sessão 12 h absolutas sem sliding; lockout temporário 5 falhas / 15 min (`locked_until`), `LOCKED` = bloqueio administrativo manual nunca alterado pelo Auth; erros de login externos genéricos; status do tenant (ACTIVE e PAST_DUE autenticam, TRIAL até `trial_ends_at`, SUSPENDED/CANCELLED não); `UserBranchAccess` obrigatório em escopo de filial; Device `INACTIVE`/`REVOKED` bloqueados.

**Ainda pendente de decisão:** tamanho mínimo de senha nova (default técnico 8) e demais regras de política de senha.

**Futuro (não implementar sem nova decisão):**
1. Pairing/autenticação de dispositivo (`device_key` continua não sendo segredo); se o usuário precisa de acesso à filial do dispositivo.
2. Rate limiting distribuído por IP/dispositivo (gateway/WAF/Redis) — **obrigatório antes de exposição do login em escala na internet**; inclui enumeração de `login_code` e amplificação de escrita em `audit_logs` por falhas de login.
3. Retenção/limpeza de sessões e LGPD de `ip_address`/`user_agent` (#9).
4. RLS (#7) e IAM database authentication.
5. Endpoints administrativos de usuário (reset, LOCKED/unlock, desativação com revogação, revogação de dispositivo) e UI de delegação de permissões, impondo a regra "ninguém concede autoridade acima da própria".
6. Sliding session, OAuth, MFA, passkeys.
7. Atribuição de `login_code` a tenants (não há fluxo de criação de tenant); `trust proxy`/origem real do IP atrás de load balancer.
8. Modo somente leitura por billing; decisão de quando PAST_DUE vira SUSPENDED (billing).
9. Rotação da chave do Auth sem derrubar todas as sessões (`kid`/múltiplas chaves).

## Pendências do M2 (Auth) originadas no M1.12 — situação após o M2
1. ~~Geração do refresh token, hash e comparação~~ **Resolvido no M2.5** (256 bits, SHA-256, comparação em tempo constante); duração de `expires_at`: 12 h absolutas (decidido).
2. ~~Rotação transacional e replay~~ **Resolvido no M2.5** (UPDATE condicional; segredo não atual revoga a sessão).
3. ~~Revogação~~ **Resolvido no M2.6** (logout, sessão, todas do usuário, do dispositivo); desativar usuário/revogar dispositivo já bloqueiam no request seguinte. Endpoints administrativos: futuro.
4. Limpeza/retenção de sessões expiradas e revogadas; LGPD de `ip_address`/`user_agent` (#9).
5. Se a CHECK `expires_at > created_at` atrapalhar importações/backfills, revisar.

## Pendências do M2 (Auth) originadas no M1.5 — situação após o M2
1. ~~Algoritmo e parâmetros de hashing~~ **Resolvido no M2.2** (Argon2id PHC, `ARGON2ID_PARAMS`).
2. Transições de `status`: semântica implementada (LOCKED/DISABLED sem prazo, `locked_until` temporário, Auth nunca muda status); LOCKED = bloqueio administrativo manual; endpoints: futuro.
3. ~~Lockout~~ **Resolvido no M2.13** (persistido, atômico); valores 5/15 min decididos; rate limiting distribuído: futuro.
4. ~~Reset administrativo com `must_change_password`~~ **Resolvido no M2.12** (serviço; endpoint: futuro).
5. ~~Normalização da matrícula~~ **Resolvido no M2** (trim + uppercase, `[A-Z0-9._-]`, 1–32, zeros preservados; CHECK no banco).
6. LGPD: `users.name` é dado pessoal e o usuário não é apagado fisicamente (#9).

## Gate do M1 (M1.14.4): classificação das pendências
**M1 — Core multi-tenant ✅** concluído. A classificação abaixo responde se é seguro começar Auth e autorização runtime; os detalhes continuam nas seções acima.

### Bloqueantes para o M2
Nenhuma. Banco limpo e caminho incremental produzem o mesmo catálogo; isolamento cross-tenant de escrita, imutabilidade de `tenant_id`, append-only de `audit_logs`, matriz runtime de `erp_app` e auditorias fail-closed estão verdes e provados por checagens negativas.

### Tratar durante o M2 (Auth e autorização)
1. ~~**Tenant context na camada de aplicação**~~ **Fundação entregue no M2.1; produtor (AuthGuard) e provider Nest de `PrismaClient` entregues no M2.7.** Texto original: `TenantContextService` (AsyncLocalStorage), `TenantScope`, `MODEL_SCOPE` e `CompanyRepository` como prova, com testes de isolamento de leitura/escrita como `erp_app`. Restam (M2): (a) o produtor do contexto — Auth/guard que resolve sessão/token, valida existência/status do tenant e chama `run()` por request; (b) provider Nest de `PrismaClient` e fiação dos repositories; (c) repositories das demais entidades seguindo o padrão; (d) checagem automática de uso direto de `PrismaClient` em código de negócio (hoje regra documentada + review; uma regra ESLint de import seria frágil e foi adiada); (e) contexto em workers/jobs (sem request: o job precisa carregar e validar o tenant explicitamente).
2. Autenticação, sessões e expiração offline (#5): hashing de senha e formato de `password_hash`, refresh token (geração, hash, rotação, replay), revogação, lockout, normalização da matrícula (seções "Pendências do M2 (Auth)").
3. Semântica da autorização (#6): resolução global x filial, status de role/usuário, fluxo de troca/remoção de UserRole e UserBranchAccess ("Pendências da autorização").
4. Provisionamento do tenant: criação das roles padrão `OWNER`/`MANAGER`/`ATTENDANT`/`KITCHEN`, reserva dos códigos, proteção de `is_system` e matriz de permissões por role (pendência 2 do M1.8). **Depende de regras de negócio a fornecer.**
5. Autenticação de dispositivo e efeito de `REVOKED`/`INACTIVE` ("Pendências de dispositivos"), na medida em que o login no PDV usar o dispositivo.
6. Se o M2 gravar eventos em `audit_logs` (ex.: login), o filtro de `metadata` do futuro `AuditService` precisa existir antes da primeira gravação com `metadata`.

### Futuro (não bloqueia o M2)
- RLS (#7) e transmissão do tenant à sessão do banco.
- Login das identidades do banco em produção: Secrets Manager ou IAM database authentication; RDS Proxy/pooler (e a garantia de `TimeZone=UTC` sem parâmetro de startup).
- Auditoria das ações do dono/admin (`pgaudit`, logs do RDS); revogar `TEMPORARY`/`CONNECT` padrão de `PUBLIC` no database.
- Compatibilidade com PostgreSQL 18.
- LGPD x imutabilidade física (#9), retenção de sessões e de `audit_logs`.
- Normalização de codes (`Branch.code`, `Role.code`), CNPJ completo (dígitos verificadores, raiz Branch x Company) e timezone IANA, em `packages/validation`/aplicação.
- Sanitização automática de `audit_logs.metadata`, catálogo de ações, instrumentação, retenção/particionamento ("Pendências do AuditService"; ver também o item 6 do M2).
- Índices baseados em workload real (`audit_logs`, `sessions.expires_at`).
- Regra opcional de lint para `import()` dinâmico do client gerado (pendência 2 do M1.14).
- Política para permissão removida/renomeada do catálogo e execução do seed no pipeline (#18).
- Demais TBDs de produto/negócio (#2, #3, #4, #8, #10–#20) seguem bloqueando apenas os módulos indicados na tabela.
