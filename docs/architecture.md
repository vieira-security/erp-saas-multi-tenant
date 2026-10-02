# Arquitetura

## Decisões
- Modular monolith; sem microserviços.
- Monorepo: apps (web, api, worker) e packages (contracts, validation, config, ui).
- Multi-tenant; tenant obtido do contexto autenticado, nunca do frontend.
- Preparado para múltiplas filiais.
- Stack: Next.js/React/Tailwind, NestJS, PostgreSQL, Prisma (inicial), TypeScript strict.

## Infraestrutura futura
AWS ECS/Fargate, RDS PostgreSQL, Redis, SQS, S3, Secrets Manager, CloudWatch.

## Pendências
- Estratégia de isolamento de tenant no banco (coluna + RLS, schema ou outro).
- Limites de módulos dentro da api.
