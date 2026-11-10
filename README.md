# ERP SaaS multi-tenant

ERP para lojas/restaurantes de alimentação em shopping centers no Brasil. Estado atual: **M1 — Core multi-tenant ✅**; **M2 — Auth e autorização runtime ✅** (login por código público da organização + matrícula + senha, Argon2id, access token em memória e refresh em cookie HttpOnly, guards globais, autorização por permissão e filial). Sem API de negócio nem frontend funcional. Marcos em `docs/product.md`.

## Estrutura

```
apps/            web, api, worker
packages/        contracts, validation, config, ui
docs/            documentação do produto e arquitetura
infrastructure/  IaC futura
```

## Requisitos

Node >= 22, npm >= 10.

## Configuração

A API exige `DATABASE_URL` (identidade `erp_app`) e `AUTH_ACCESS_TOKEN_SECRET` (>= 32 bytes aleatórios); em produção também `AUTH_ALLOWED_ORIGINS`. Sem eles não sobe. Nomes em `apps/api/.env.example`; valores nunca no git.

## Comandos

```
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Contribuição: veja `CLAUDE.md`.
