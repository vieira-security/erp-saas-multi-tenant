# Arquitetura

## Decisões
- Modular monolith; sem microserviços.
- Monorepo com npm workspaces: apps (`web`, `api`, `worker`) e packages (`contracts`, `validation`, `config`, `ui`).
- Preparado para múltiplas filiais.
- TypeScript strict em todo o código.

## Stack instalada
| Workspace | Tecnologias |
|---|---|
| `apps/web` | Next.js (App Router), React, Tailwind CSS v4 |
| `apps/api` | NestJS (ESM), Prisma (CLI/schema), PostgreSQL |
| `apps/worker` | Node.js/TypeScript mínimo; filas ainda não implementadas |
| Testes | Vitest (runner padrão); Playwright será configurado quando houver E2E |

## Multi-tenancy (decisão aprovada)
- Banco PostgreSQL **compartilhado**.
- Dados pertencentes ao cliente usam `tenant_id`.
- Isolamento **obrigatório na aplicação**.
- O frontend **nunca** escolhe livremente `tenant_id`; o tenant vem do contexto autenticado.
- Modelagem compatível com PostgreSQL Row-Level Security (RLS). **RLS não está ativa** ainda.
- **Não** usar database-per-tenant. **Não** usar schema-per-tenant.

## Infraestrutura futura
AWS ECS/Fargate, RDS PostgreSQL, Redis, SQS, S3, Secrets Manager, CloudWatch. Nada disso está implementado.

## Pendências
- Limites de módulos dentro da api.
- Estratégia de ativação de RLS (quando e como).
