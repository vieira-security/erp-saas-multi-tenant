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
- Repositories/services tenant-scoped usam `TenantContextService` + `TenantScope` (`apps/api/src/tenancy/`): `tenant_id + id` em toda query, inputs sem `tenantId`, falha sem contexto. Prisma direto em código de negócio exige revisão explícita; seed, migrations, testes e infraestrutura são exceções.
- Identidade e tenant em runtime vêm só do `AuthContext`/`TenantContext` abertos pelo AuthGuard (`apps/api/src/auth/`); autorização por `AuthorizationService`/`PermissionGuard` (`apps/api/src/authorization/`). Ver `docs/security.md`.
- Não inventar regras fiscais ou de negócio; registrar dúvidas em `docs/`.
- Não adicionar dependências sem necessidade clara.

## Multi-tenancy
Banco compartilhado com `tenant_id` e isolamento na aplicação; compatível com RLS (inativa). Sem database/schema-per-tenant. Detalhes em `docs/architecture.md`.

## Documentação
Ponto de entrada: `docs/architecture.md`. Pendências em `docs/open-questions.md`; não decidir TBDs sem aprovação.
