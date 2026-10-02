# Deploy

## Fluxo
- `main` estável; branches curtas; toda mudança por Pull Request.
- CI (lint, typecheck, test, build) antes do merge. Pipeline de CI: **TBD** (ainda não existe).
- Deploy gradual.

## Operação
- Manutenção relevante é avisada dentro do ERP.
- Pedidos em andamento não podem ser perdidos durante deploy/manutenção.
- Migrations compatíveis sempre que possível (expand/contract); destrutivas exigem revisão explícita.
- Rollback ou desativação da feature (feature flag) quando aplicável.

## Alvo futuro (não implementado)
AWS ECS/Fargate, RDS PostgreSQL, Redis, SQS, S3, Secrets Manager, CloudWatch. O backend stateless facilita a escala horizontal.

## Incidentes
- O ERP é a origem do chamado do cliente; ferramenta Kanban externa para a equipe (principal **TBD**; Jira segunda opção).
- Prioridades **P1, P2, P3, P4**; registrar causa inicial e causa raiz.
- P1/P2 geram alerta ativo; incidentes globais podem agrupar vários clientes.
- Definição e SLAs de cada prioridade: **TBD**.

## Pendências (TBD)
Ambientes (dev/staging/prod), estratégia de deploy gradual (canary/blue-green), observabilidade, backup/restore, estratégia de feature flags, provedor de billing ([architecture.md](architecture.md)).
