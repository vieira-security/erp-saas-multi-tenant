# Estratégia de testes

Testes em camadas. Toda feature relevante possui testes; toda correção relevante gera teste de regressão quando tecnicamente viável. Antes do PR: lint, typecheck e testes relacionados.

## Camadas
| Camada | Ferramenta | Estado |
|---|---|---|
| Unitários | **Vitest** (padrão; não usar Jest) | Ativo (smoke de bootstrap) |
| Módulos NestJS | `@nestjs/testing` quando apropriado | Instalado, ainda não usado |
| Integração com PostgreSQL | Vitest + PostgreSQL real via `TEST_DATABASE_URL` | Ativo (Tenant, migrations) |
| E2E / PDV | Playwright | Futuro; instalar ao iniciar frontend funcional |
| Responsividade | **TBD** (provavelmente via Playwright) | Futuro |
| Impressoras físicas | Manual/hardware | Futuro |
| Falha de internet / offline | Playwright + simulação de rede | Futuro |
| Idempotência | Integração | Futuro |
| **Isolamento multi-tenant** | Integração (obrigatório) | Futuro |
| Performance/load | Quando necessário; ferramenta **TBD** | Futuro |

## Integração com PostgreSQL
`npm run test:integration` (fora do `npm test`, pois exige servidor). `TEST_DATABASE_URL` aponta para um servidor PostgreSQL **dedicado a testes**; `DATABASE_URL` nunca é lida. A cada execução o setup global cria um banco vazio `erp_test_<timestamp>_<aleatório>` (fuso padrão `America/Sao_Paulo`, para detectar sessões fora de UTC), aplica `prisma migrate deploy` e o remove ao final. PostgreSQL nunca é mockado em testes de schema/constraints. Ferramenta para provisionar o servidor (local/CI) segue **TBD** (#17).

## Isolamento multi-tenant
Para cada módulo com dado de cliente: provar que o tenant A não lê, altera nem enumera dados do tenant B; que a ausência de tenant context falha; e, quando a RLS for ativada, que ela barra acessos mesmo com falha na camada de aplicação.

## Comandos
`npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`

Na api, o `test` executa `nest build` e um teste que inicia a API como processo filho e encerra apenas o PID iniciado.
