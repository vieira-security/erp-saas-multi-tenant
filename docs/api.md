# API HTTP

Fonte da verdade dos contratos: `packages/contracts` (contract-first). Este documento registra as convenções; rotas,
campos e códigos de erro de cada módulo estão nos comentários dos próprios arquivos do pacote.

## Consumo de `packages/*`
- Os packages exportam TypeScript sem build (`main`/`types` = `src/index.ts`).
- `apps/web` (Next.js) pode importar tipos e valores (precisa de `transpilePackages` no `next.config.ts` para valores).
- `apps/api` compila com `tsc` e roda o `dist` no Node: **só `import type`** de `@erp/*`. Import de valor passa no
  typecheck e quebra em runtime; a regra de lint `@typescript-eslint/no-restricted-imports` bloqueia.
- Consequência: regras com lógica em runtime (CNPJ, timezone, código de filial) são implementadas na API; o frontend pode
  usar as constantes do contrato só para feedback imediato de formulário. A API é sempre a autoridade.
- Build de packages para runtime (para compartilhar validadores de fato) fica para quando houver necessidade concreta.

## Convenções (M3)
- Autenticação: `Authorization: Bearer <accessToken>` em toda rota de negócio; o tenant vem do token, nunca do request.
- Corpo desconhecido é rejeitado: qualquer campo fora do contrato (inclusive `tenantId`) -> `400 validation_failed`
  com `unknown_field`. Strings são aparadas antes de validar.
- Erros: `{ "error": "<code>", "details"?: [{ "field", "issue" }] }`. Códigos estáveis em `API_ERROR_CODES`.
  - 400 `validation_failed` (com `details`); 401 `unauthenticated`; 403 `forbidden`; 404 `not_found`; 409 específicos.
  - Recurso de outro tenant responde exatamente como inexistente (404), nunca 403.
- Paginação: `?page=1&pageSize=20` (máx. 100). Resposta `{ items, page, pageSize, total, totalPages }`. Ordem estável
  por criação.
- Datas ISO 8601 UTC; IDs UUID.
- Status (`ACTIVE`/`INACTIVE`) muda só por ações dedicadas (`POST .../activate|deactivate`), idempotentes.
