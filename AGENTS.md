# AGENTS.md

Instruções para agentes de IA. As regras de workflow estão em `CLAUDE.md` e valem para todos os agentes.

## Arquitetura

- **Modular monolith.** Sem microserviços.
- Monorepo (npm workspaces):
  - `apps/web`: Next.js, React, Tailwind (PWA futuro).
  - `apps/api`: NestJS, PostgreSQL, Prisma.
  - `apps/worker`: processamento assíncrono (futuro SQS).
  - `packages/contracts`, `packages/validation`, `packages/config`, `packages/ui`.
- Edge Server não existe ainda; a arquitetura apenas deve permitir adicioná-lo (`docs/offline-edge.md`).
- n8n pode orquestrar automações, mas nunca é fonte das regras de negócio.

## Regras

- TypeScript strict em todo o código.
- Tenant sempre do contexto autenticado, nunca do input do cliente.
- Não inventar regras fiscais ou de negócio; registrar dúvidas em `docs/`.
- Não adicionar dependências sem necessidade clara.

## Multi-tenancy
Banco compartilhado com `tenant_id` e isolamento na aplicação; compatível com RLS (inativa). Sem database/schema-per-tenant. Detalhes em `docs/architecture.md`.
