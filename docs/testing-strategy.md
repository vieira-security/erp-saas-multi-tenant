# Estratégia de testes

Testes em camadas. Toda feature relevante possui testes; toda correção relevante gera teste de regressão quando tecnicamente viável. Antes do PR: lint, typecheck e testes relacionados.

## Camadas
| Camada | Ferramenta | Estado |
|---|---|---|
| Unitários | **Vitest** (padrão; não usar Jest) | Ativo (smoke de bootstrap) |
| Módulos NestJS | `@nestjs/testing` quando apropriado | Instalado, ainda não usado |
| Integração com PostgreSQL | Vitest + PostgreSQL real via `TEST_DATABASE_URL` | Ativo (models do M1, migrations, catálogo, privilégios) |
| E2E / PDV | Playwright | Futuro; instalar ao iniciar frontend funcional |
| Responsividade | **TBD** (provavelmente via Playwright) | Futuro |
| Impressoras físicas | Manual/hardware | Futuro |
| Falha de internet / offline | Playwright + simulação de rede | Futuro |
| Idempotência | Integração | Futuro |
| **Isolamento multi-tenant** | Integração (obrigatório) | Futuro |
| Performance/load | Quando necessário; ferramenta **TBD** | Futuro |

## Integração com PostgreSQL
`npm run test:integration` (fora do `npm test`, pois exige servidor). `TEST_DATABASE_URL` aponta para um servidor PostgreSQL **dedicado a testes**; `DATABASE_URL` nunca é lida. A cada execução o setup global cria um banco vazio `erp_test_<timestamp>_<aleatório>` (fuso padrão `America/Sao_Paulo`, para detectar sessões fora de UTC) e roles únicas da execução, aplica os scripts de `infrastructure/postgres/` e `prisma migrate deploy` como `erp_migrator`, e remove banco e roles ao final. Testes de schema conectam como `erp_migrator`; `app-role.int.test.ts` conecta como `erp_app`. Versão de validação: PostgreSQL 17.x, servidor com encoding `UTF8`. PostgreSQL nunca é mockado em testes de schema/constraints. Ferramenta para provisionar o servidor (local/CI) segue **TBD** (#17).

## Testes de catálogo (obrigatórios)
Parte das garantias do banco não existe no `schema.prisma` e o `prisma migrate diff` não percebe quando somem: CHECKs, índices parciais, funções, triggers, ACLs, ownership e default privileges ([database.md](database.md), "Pontos cegos do Prisma"). Elas são protegidas **somente** por testes que consultam o catálogo do PostgreSQL (`pg_constraint`, `pg_index`, `pg_trigger`, `pg_proc`, ACLs). Regras:
- Os testes são fail-closed: inventários exatos (índices, CHECKs, índices parciais, funções/triggers, matriz de privilégios); objeto novo ou ausente faz o teste falhar até ser declarado.
- Cada auditoria tem **sondas**: criam o desvio numa transação sempre desfeita (`inRolledBackTransaction`) e provam que a auditoria o detecta. Preferir tabelas-sonda `audit_probe_*` a alterar tabelas reais, para não travar os outros arquivos que rodam em paralelo.
- Verificar SQLSTATE, nome de constraint/índice, catálogo e estado final; evitar depender do texto completo de mensagens de erro.
- Toda mudança de schema físico passa por uma checagem negativa manual antes do PR (remover/alterar o objeto temporariamente e ver os testes falharem), registrada na entrega.
- Arquivos: `migration.int.test.ts` (definições exatas por tabela e inventário de funções/triggers), `org-integrity.int.test.ts` (classificação de tabelas, FKs, credenciais, imutabilidade de `tenant_id`), `schema-hardening.int.test.ts` (índices, cobertura de FKs, redundância, uniques auxiliares, índices parciais, CHECKs), `runtime-privileges.int.test.ts` (ownership, ACL, roles), `app-role.int.test.ts` (operações reais como `erp_app`). Helpers em `table-audit.ts`.

## Isolamento multi-tenant
Para cada módulo com dado de cliente: provar que o tenant A não lê, altera nem enumera dados do tenant B; que a ausência de tenant context falha; e, quando a RLS for ativada, que ela barra acessos mesmo com falha na camada de aplicação.

## Comandos
`npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`

Na api, o `test` executa `nest build` e um teste que inicia a API como processo filho e encerra apenas o PID iniciado.
