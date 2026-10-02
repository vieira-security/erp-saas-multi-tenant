# Estratégia de testes

Testes em camadas. Toda feature relevante possui testes; toda correção relevante gera teste de regressão quando tecnicamente viável. Antes do PR: lint, typecheck e testes relacionados.

## Camadas
| Camada | Ferramenta | Estado |
|---|---|---|
| Unitários | **Vitest** (padrão; não usar Jest) | Ativo (smoke de bootstrap) |
| Módulos NestJS | `@nestjs/testing` quando apropriado | Instalado, ainda não usado |
| Integração com PostgreSQL | **TBD** (ferramenta/estratégia de banco de teste) | Futuro |
| E2E / PDV | Playwright | Futuro; instalar ao iniciar frontend funcional |
| Responsividade | **TBD** (provavelmente via Playwright) | Futuro |
| Impressoras físicas | Manual/hardware | Futuro |
| Falha de internet / offline | Playwright + simulação de rede | Futuro |
| Idempotência | Integração | Futuro |
| **Isolamento multi-tenant** | Integração (obrigatório) | Futuro |
| Performance/load | Quando necessário; ferramenta **TBD** | Futuro |

## Isolamento multi-tenant
Para cada módulo com dado de cliente: provar que o tenant A não lê, altera nem enumera dados do tenant B; que a ausência de tenant context falha; e, quando a RLS for ativada, que ela barra acessos mesmo com falha na camada de aplicação.

## Comandos
`npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`

Na api, o `test` executa `nest build` e um teste que inicia a API como processo filho e encerra apenas o PID iniciado.
