# Estratégia de testes

Testes em camadas. Toda feature relevante possui testes; toda correção relevante gera teste de regressão quando tecnicamente viável. Antes do PR: lint, typecheck e testes relacionados.

## Camadas
| Camada | Ferramenta | Estado |
|---|---|---|
| Unitários | **Vitest** (padrão; não usar Jest) | Ativo (smoke de bootstrap, health, catálogo de permissões) |
| Módulos NestJS | `@nestjs/testing` | Ativo (M2: `AppModule` real em HTTP local com `erp_app`, `test/integration/http-app.ts`) |
| Integração com PostgreSQL | Vitest + PostgreSQL real via `TEST_DATABASE_URL` | Ativo (models do M1, migrations, catálogo, privilégios) |
| E2E / PDV | Playwright | Futuro; instalar ao iniciar frontend funcional |
| Responsividade | **TBD** (provavelmente via Playwright) | Futuro |
| Impressoras físicas | Manual/hardware | Futuro |
| Falha de internet / offline | Playwright + simulação de rede | Futuro |
| Idempotência | Integração | Futuro |
| **Isolamento multi-tenant** | Integração (obrigatório) | Ativo no banco (FKs compostas, imutabilidade de `tenant_id`, gate do M1); camada de aplicação (TenantContext + TenantScope) ativa desde o M2.1 |
| Performance/load | Quando necessário; ferramenta **TBD** | Futuro |

## Integração com PostgreSQL
`npm run test:integration` (fora do `npm test`, pois exige servidor). `TEST_DATABASE_URL` aponta para um servidor PostgreSQL **dedicado a testes**; `DATABASE_URL` nunca é lida. A cada execução o setup global cria um banco vazio `erp_test_<timestamp>_<aleatório>` (fuso padrão `America/Sao_Paulo`, para detectar sessões fora de UTC) e roles únicas da execução, aplica os scripts de `infrastructure/postgres/` e `prisma migrate deploy` como `erp_migrator`, e remove banco e roles ao final. Testes de schema conectam como `erp_migrator`; `app-role.int.test.ts` conecta como `erp_app`. Versão de validação: PostgreSQL 17.x, servidor com encoding `UTF8`. PostgreSQL nunca é mockado em testes de schema/constraints. Ferramenta para provisionar o servidor (local/CI) segue **TBD** (#17).

## Testes de catálogo (obrigatórios)
Parte das garantias do banco não existe no `schema.prisma` e o `prisma migrate diff` não percebe quando somem: CHECKs, índices parciais, funções, triggers, ACLs, ownership e default privileges ([database.md](database.md), "Pontos cegos do Prisma"). Elas são protegidas **somente** por testes que consultam o catálogo do PostgreSQL (`pg_constraint`, `pg_index`, `pg_trigger`, `pg_proc`, ACLs). Regras:
- Os testes são fail-closed: inventários exatos (índices, CHECKs, índices parciais, funções/triggers, matriz de privilégios); objeto novo ou ausente faz o teste falhar até ser declarado.
- Cada auditoria tem **sondas**: criam o desvio numa transação sempre desfeita (`inRolledBackTransaction`) e provam que a auditoria o detecta. Preferir tabelas-sonda `audit_probe_*` a alterar tabelas reais, para não travar os outros arquivos que rodam em paralelo.
- Verificar SQLSTATE, nome de constraint/índice, catálogo e estado final; evitar depender do texto completo de mensagens de erro.
- Toda mudança de schema físico passa por uma checagem negativa manual antes do PR (remover/alterar o objeto temporariamente e ver os testes falharem), registrada na entrega.
- Arquivos: `migration.int.test.ts` (definições exatas por tabela e inventário de funções/triggers), `org-integrity.int.test.ts` (classificação de tabelas, FKs, credenciais, imutabilidade de `tenant_id`), `schema-hardening.int.test.ts` (índices, cobertura de FKs, redundância, uniques auxiliares, índices parciais, CHECKs), `runtime-privileges.int.test.ts` (ownership, ACL, roles), `app-role.int.test.ts` (operações reais como `erp_app`), `m1-gate.int.test.ts` (gate final do M1: inventário de models/tabelas, todas as auditorias juntas, isolamento entre dois tenants e fluxo de runtime como `erp_app`), `tenant-context.int.test.ts` (isolamento na aplicação: `CompanyRepository` com dois tenants, concorrência, transações, Permission global; `MODEL_SCOPE` x classificação de tabelas). Helpers em `table-audit.ts`.

**Auth/autorização (M2)**, todos como `erp_app`: `auth-login.int.test.ts` (login, enumeração, DISABLED/LOCKED, lockout e falhas concorrentes, tenant, dispositivo, rehash), `auth-session.int.test.ts` (rotação, replay, 2/5 refreshes concorrentes, revogação durante refresh, tokens cross-tenant, logout/revogação), `auth-guard.int.test.ts` (AuthGuard via HTTP: deny by default, claims adulteradas, tenant de header/query/body ignorado, sessão de outro usuário, revogação imediata, `must_change_password`, 60 requests concorrentes de dois tenants), `authorization.int.test.ts` (roles tenant-wide x filial, inativas, usuários bloqueados, cross-tenant, PermissionGuard 401/403), `auth-password.int.test.ts` (troca e reset), `tenant-provisioning.int.test.ts` (idempotência, concorrência, conflitos). Gate do M2: refresh forjado com `tenantId`/`sessionId` conhecidos não revoga nada; refresh concorrendo com `revokeAll` e reset de senha; `UserBranchAccess` obrigatório em escopo de filial; marca pública de classe/herança ignorada; headers `Authorization` duplicados; requisitos de permissão de classe + método; stress de 300 requests com transação/`Promise.all`/falhas; `security-audit.test.ts` (allowlist contra nomes sensíveis e campos contrabandeados). Checagens negativas registradas no relatório do gate (12 mutações, todas detectadas). Fechamento do M2: `auth-http.int.test.ts` (login por código público, cookie do refresh e flags, rotação/replay/cookie forjado via HTTP, logout, CSRF por `Origin`, trial/PAST_DUE/SUSPENDED/CANCELLED, matrícula normalizada, cross-tenant), unitários de transporte (`src/auth/http/transport.test.ts`) e de normalização (`src/users/employee-number.test.ts`), matriz aprovada (`default-roles.test.ts`). O caminho incremental das migrations do M2 com dados existentes (normalização, colisão e valor inválido abortando) foi validado manualmente no fechamento. Fixtures em `auth-fixtures.ts` (segredo aleatório por execução). Unitários em `apps/api/src/{auth,config,tenants}/**/*.test.ts`; `test/boot-config.smoke.test.ts` prova que a API não sobe sem segredo forte nem `DATABASE_URL`. Testes unitários de `TenantContextService`/`TenantScope` em `apps/api/src/tenancy/*.test.ts` (sem banco).

## Isolamento multi-tenant
No banco (M1): `m1-gate.int.test.ts` prova, como `erp_app`, que nenhum vínculo cross-tenant é aceito e que nenhuma linha muda de tenant; leitura não é barrada pelo banco enquanto a RLS estiver inativa. Na aplicação (M2.1): `tenant-context.int.test.ts` prova que um repository com `TenantScope` não lê, lista nem altera dados do outro tenant e falha sem contexto; os testes inicializam o contexto diretamente com `TenantContextService.run()` (não há header nem middleware de tenant). Para cada módulo com dado de cliente (a partir do M2): provar que o tenant A não lê, altera nem enumera dados do tenant B; que a ausência de tenant context falha; e, quando a RLS for ativada, que ela barra acessos mesmo com falha na camada de aplicação.

## Comandos
`npm run lint` · `npm run typecheck` · `npm run test` · `npm run build` · `npm run test:integration` (exige `TEST_DATABASE_URL`)

Na api, o `test` executa `nest build` e um teste que inicia a API como processo filho e encerra apenas o PID iniciado.
