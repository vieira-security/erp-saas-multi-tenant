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

## Convenções acrescentadas no M4
- **Campos aninhados em `details`:** `field` é o caminho do campo (`optionGroups[0].options[1].priceDelta`, `optionGroups[2].options`).
  Objetos aninhados seguem a mesma regra estrita (campo desconhecido = `unknown_field`). Listas: `too_few`/`too_many`.
- **Dinheiro (`Money`):** string decimal em reais com ponto (`"12.50"`). Requests aceitam `"12"`, `"12.5"`, `"12.50"` (até
  `"9999999999.99"`); number, expoente, sinal, vírgula ou mais de 2 casas = `invalid_money`. Respostas sempre com 2 casas.
- **Inteiros** (`sortOrder`, `minChoices`...): number JSON inteiro; fração ou string = `invalid_type`, fora da faixa = `invalid_value`.
- **Escopo de filial na URL** (`/branches/:branchId/...`): sem acesso à filial, filial de outro tenant ou inexistente = 403
  `forbidden` (o guard decide antes de qualquer consulta ao recurso); recursos do tenant fora da filial seguem 404.
- **Busca textual** (`q`): "contém", sem diferenciar maiúsculas; `%`, `_` e `\` são literais (sem curingas).

## Convenções acrescentadas no M5
- **`details` também em 409:** `order_item_unavailable` traz os mesmos `details` da validação dos itens
  (`items[2].productId` `unavailable`, `items[2].optionIds` `invalid_choices`).
- **Total acima de `numeric(12,2)`** (`"9999999999.99"`): 400 `validation_failed` com `{ "field": "items", "issue": "invalid_value" }`,
  ao montar/substituir itens e na confirmação (o contrato não tem código próprio).
- **Listagem de pedidos:** mais recentes primeiro (`createdAt` desc, `id` desc), exceção à ordem padrão prevista no contrato;
  `status` aceita lista separada por vírgula (`CONFIRMED,PREPARING`); `businessDate` = `YYYY-MM-DD` de calendário real.
- **Corpo opcional** em `POST /branches/:branchId/orders` e `.../cancel`: ausente equivale a `{}`.

## Convenções acrescentadas no M6
- **Pagamentos aninhados:** `payments[1].receivedAmount` (`required` em CASH, `invalid_value` se menor que o valor ou em outro método).
- **`Money` com sinal só em `difference`** e nos totais líquidos do caixa (`"-5.00"`); todo o resto é ≥ 0.
- **`payment_total_mismatch`:** o pedido segue EDITING e o rascunho é atualizado com os preços vigentes; o `GET` do pedido devolve o
  total a pagar (default técnico, ver open-questions).
- **Caixa de outro operador:** `GET` = 404 sem `cash.close` (não revela existência); `close` = 403.

## `GET /me` e ajuste do Auth (KAN-52)
- `GET /me` (contrato `MeDto` em `packages/contracts/src/me.ts`) fica no módulo `organization`, no mesmo `MeController` de
  `GET /me/branches` (dados do próprio usuário; só autenticação). `/me/branches` continua com o significado do M3 (só
  filiais operáveis); `/me` lista todas as filiais com acesso, com `operable` e permissões por filial.
- `PERMISSION_CODES` (contrato) é igual ao catálogo do seed, na mesma ordem: um teste unitário falha se o catálogo mudar
  sem atualizar o contrato.
- `POST /auth/login` e `POST /auth/password`: corpo inválido agora responde no formato padrão
  `400 { error: "validation_failed", details }` (antes, `{ statusCode, message: "invalid_request", error }` do Nest).
  Campo desconhecido passa a ser `unknown_field`, como nas demais rotas. Nenhuma outra resposta do Auth mudou.
