# ERP SaaS multi-tenant

ERP para lojas/restaurantes de alimentação em shopping centers no Brasil. Estado atual: **M1 — Core multi-tenant ✅**; **M2 — Auth e autorização runtime ✅** (login por código público da organização + matrícula + senha, Argon2id, access token em memória e refresh em cookie HttpOnly, guards globais, autorização por permissão e filial). Backend até o M6 (caixa e pagamentos). Frontend: fundação do `apps/web` (proxy para a API, cliente HTTP, mocks tipados, shell com seletor de filial); telas de negócio nas próximas entregas. Marcos em `docs/product.md`.

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

Ambiente local completo (PostgreSQL, API, web e dados demo para login): [docs/dev-setup.md](docs/dev-setup.md).

Web sem API (dados de exemplo): `NEXT_PUBLIC_API_MOCKS=1 npm run dev -w @erp/web`. Com a API: o web acessa via proxy do Next (`/auth/*`, `/api/*` -> `API_URL`, default `http://localhost:3001`), e a API precisa de `AUTH_ALLOWED_ORIGINS=http://localhost:3000` e `AUTH_COOKIE_SECURE=false` em dev. Variáveis em `apps/web/.env.example`.

## Comandos

```
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run db:seed       # catálogo de permissões (como erp_migrator)
npm run db:seed:dev   # dados demo, só em desenvolvimento (docs/dev-setup.md)
```

Contribuição: veja `CLAUDE.md`.
