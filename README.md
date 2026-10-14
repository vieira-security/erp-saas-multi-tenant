# ERP SaaS multi-tenant

ERP para lojas/restaurantes de alimentação em shopping centers no Brasil. Estado atual: **M1 — Core multi-tenant ✅** (schema multi-tenant, segurança do banco e RBAC estrutural no PostgreSQL; sem Auth, API de negócio nem frontend funcional). Marcos em `docs/product.md`.

## Estrutura

```
apps/            web, api, worker
packages/        contracts, validation, config, ui
docs/            documentação do produto e arquitetura
infrastructure/  IaC futura
```

## Requisitos

Node >= 22, npm >= 10.

## Comandos

```
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Contribuição: veja `CLAUDE.md`.
