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

## Funcionários: leitura (`GET /users`, desbloqueia KAN-29)

- `GET /users` (`user.read`, tenant) → `Page<UserSummaryDto>`; filtros `status` e `search` (nome contém, sem diferenciar maiúsculas, ou matrícula exata). Ordem por `name` e depois `id` — exceção à ordem por criação, porque a lista serve para achar a pessoa.
  - Query estrita (mesmo parser das outras listagens): `page`/`pageSize` (padrão 20, máx. 100); `status` fora de `ACTIVE | DISABLED | LOCKED` → `invalid_value`; `search` aparado, vazio → `too_short`, acima de 100 → `too_long`; qualquer outro campo (inclusive `tenantId`) → `unknown_field`.
  - `search`: `name ILIKE '%termo%'` com `%`, `_` e `\` do termo escapados (texto literal, sempre parâmetro) **ou** `employee_number` igual ao termo normalizado pela mesma regra do login (`e001` encontra `E001`; termo que não é matrícula válida só busca por nome). Matrícula parcial não casa.
  - Ordem: `name COLLATE "C"` e, em empate, `id` — ordem de code point, igual em qualquer banco (não depende da collation padrão). Consequência: maiúsculas vêm antes de minúsculas (`"Zulu"` antes de `"beta"`). Página e contagem são 2 queries SQL parametrizadas numa transação (o Prisma não aceita `COLLATE` no `orderBy`), com `tenant_id` do TenantContext.
- `GET /users/:userId` (`user.read`) → `UserDto` com as roles (tenant inteiro ou por filial, inclusive INACTIVE para exibição) | 404 `not_found` (inexistente, de outro tenant ou id que não é UUID).
  - Roles numa única leitura com relações aninhadas (sem query por role), ordenadas em memória por código: tenant inteiro primeiro, depois `branch.code`, depois `code`. Role `ARCHIVED` (existe no banco, não no contrato) sai como `INACTIVE`.
- Nunca expõe hash de senha, tentativas de login, bloqueio temporário nem sessões.
- Implementação: `apps/api/src/users/` (`UsersModule`, `UsersController` em `@Controller("users")`). `users/:userId/branch-access` continua no `OrganizationModule` (M3). Sem auditoria (leitura, como as demais listagens).
- Cadastro, edição, desativação, atribuição de roles e reset de senha: ver "Funcionários: gestão" abaixo.

## Funcionários: gestão (contratos)

- `POST /users`, `PATCH /users/:userId` (só nome), `PUT /users/:userId/roles` (substitui o conjunto), `POST /users/:userId/deactivate|activate|reset-password|unlock`, todos com `user.manage` no tenant; `GET /roles` com `role.read`. Detalhes e erros em `packages/contracts/src/users.ts` e `roles.ts`.
- Decisões de produto: matrícula digitada pelo gestor e imutável; senha temporária digitada pelo gestor, com troca obrigatória; dono e gerente gerenciam, mas nunca acima da própria autoridade; desativar derruba as sessões na hora, sem exclusão física, nunca a si mesmo nem o último Proprietário; o reset de senha destrava e derruba as sessões; desbloquear destrava sem trocar senha.
- Novos códigos 409: `employee_number_already_exists`, `cannot_target_self`, `last_owner_required`, `user_has_open_cash_session`, `role_inactive`, `branch_access_required`.

### Implementação da gestão

- Rotas de funcionário em `UsersController` (`apps/api/src/users/`), regras em `UserManagementService`. `GET /roles` ficou em módulo próprio (`apps/api/src/roles/roles.module.ts`, `RolesModule`), só leitura.
- **Ordem das checagens:** corpo (400, no controller, antes de qualquer consulta) → alvo no tenant (404) → autoridade sobre o alvo (403) → roles do corpo existem no tenant (400 `roles[i].roleId`, só `PUT /roles`) → autoridade sobre cada role que entra/sai (403) → regras de negócio (409). Entre os 409: `cannot_target_self` (antes de abrir a transação), depois `role_inactive`, `branch_access_required`, `last_owner_required`, `user_has_open_cash_session`.
- `POST /users` responde 201; as demais respondem 200 com o `UserDto` atualizado (inclusive na chamada idempotente, sem gravar nada).
- `PUT /roles`: atribuição já existente (mesma role e escopo) não é tocada, nem se a role estiver inativa; só as que entram precisam de role ACTIVE. Violação da FK composta (`user_roles` → `user_branch_access`, corrida com a revogação do acesso) vira 409 `branch_access_required`; violação da unique de matrícula (corrida no cadastro) vira 409 `employee_number_already_exists`.
- `GET /roles`: todas as roles do tenant, `isSystem` primeiro e depois `code` (comparação por código), permissões por código, `ARCHIVED` como `INACTIVE`.

## M7 — Cozinha (contratos)

- Setores de preparo do tenant (`/kitchen-sectors`), ligados/desligados por filial; produto ganha `kitchenSectorId` (`null` = padrão).
- Comandas por setor geradas na confirmação (`/branches/:branchId/kitchen-tickets`), com status WAITING → PREPARING → READY; o status do pedido é derivado delas; `start`/`ready` do pedido viram atalho.
- Permissão nova `order.prepare` (dono, gerente, atendente, cozinha). Impressão pelo navegador com `lines` de 48 colunas e contagem de vias.
- Detalhes em `packages/contracts/src/kitchen.ts`.

### Implementação do M7
- Módulo `apps/api/src/kitchen/`: `KitchenSectorsController` (`/kitchen-sectors`, escopo de tenant) e `BranchKitchenController` (`/branches/:branchId/kitchen-sectors` e `/kitchen-tickets`, escopo de filial com `@RequireBranchPermissions`). Regras puras em `kitchen-rules.ts` (setor efetivo, fluxo da comanda, status derivado) e `print-layout.ts` (texto de 48 colunas); travas em `kitchen-lock.ts`; integração com o pedido em `KitchenOrderFlow` (exportado para o `OrdersModule`).
- **Setor efetivo do item:** setor do produto principal (`products.kitchen_sector_id`) se ele recebe comandas na filial (ACTIVE no tenant e ligado na filial); senão o padrão. Combo vai inteiro no setor do produto principal (opções e produtos vinculados não mudam o setor).
- **Confirmação:** dentro da transação do M5/M6, depois de gravar o status CONFIRMED, trava os setores do tenant e os ajustes da filial `FOR SHARE` e cria uma comanda por setor efetivo com seus itens (`kitchen_ticket_items` aponta para `order_items`; os dados que a cozinha vê saem do snapshot da venda). Nome e código do setor são copiados na comanda.
- **start/ready da comanda:** trava o pedido (`FOR UPDATE`) e depois as comandas dele (por `id`), valida a transição (409 `kitchen_ticket_invalid_transition`, inclusive repetir ou comanda CANCELLED) e recalcula o status do pedido na mesma transação: todas WAITING = CONFIRMED; todas READY = READY; qualquer outra mistura = PREPARING. O pedido anda pelas setas do M5 (CONFIRMED → PREPARING → READY), gravando `preparingAt`/`readyAt` do relógio injetável.
- **Atalhos do pedido** (`POST /orders/:id/start|ready`, agora `order.prepare`): com comandas, `start` move as WAITING para PREPARING e `ready` move todas as abertas (WAITING ou PREPARING) para READY; nenhuma a mover = 409 `order_invalid_transition`. `ready` a partir de WAITING grava início e pronto juntos na comanda, e o pedido passa por PREPARING e READY no mesmo instante. Pedido sem comandas (confirmado antes do M7) segue o M5. `deliver` continua com `order.create` e exige READY.
- **Cancelamento do pedido:** na mesma transação do estorno do M6, toda comanda não cancelada vira CANCELLED (`cancelledAt`); nada é apagado.
- **`print`:** `UPDATE ... SET print_count = print_count + 1 ... RETURNING` (via atômica: impressões simultâneas recebem vias distintas), depois monta `lines`. Não muda status nem pedido.
- **Listagens:** `GET /kitchen-sectors` e `GET /branches/:branchId/kitchen-sectors` (padrão primeiro, `sortOrder`, `name` por código, `id`); `GET /kitchen-tickets` em ordem de chegada (`createdAt`, `id`), filtros `sectorId` (UUID), `status` (CSV de `KITCHEN_TICKET_STATUSES`; inválido = 400 `invalid_value`) e `businessDate` (dia do pedido), paginação padrão; itens, número e dia do pedido na mesma leitura (sem N+1). `OrderDto.kitchenTickets` vem no `include` do detalhe do pedido.
- **Produto:** `kitchenSectorId` no create/update e nos DTOs; setor inexistente ou de outro tenant = 400 `invalid_value` em `kitchenSectorId` (qualquer status é aceito; setor INACTIVE manda o item para o padrão na confirmação).
- `PATCH /kitchen-sectors/:id` com corpo vazio devolve o setor sem gravar (mesma convenção das outras PATCH do repo; ver open-questions).

## Histórico de auditoria e preferências (contratos, KAN-41 e KAN-42)

- `GET /audit-logs` (`audit.read`): eventos com filial nas filiais do usuário; eventos do tenant exigem também `audit.read_tenant` (só o dono). Ordem: mais recente primeiro. Catálogo de ações em `AUDIT_ACTIONS` (`packages/contracts/src/audit.ts`); alterações guardam antes e depois dos campos que mudaram.
- `GET/PUT /me/preferences`: `catalogView` `GRID` (default) ou `LIST`, por usuário.
