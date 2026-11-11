# Banco de dados

## Estado atual
PostgreSQL via Prisma. Models: `Tenant` (tabela `tenants`, migration `20261002000000_create_tenants`), `Company` (tabela `companies`, migration `20261002010000_create_companies`), `Branch` (tabela `branches`, migration `20261002020000_create_branches`), `User` (tabela `users`, migration `20261002030000_create_users`), `UserBranchAccess` (tabela `user_branch_access`, migration `20261002040000_create_user_branch_access`), `Role` (tabela `roles`, migration `20261002050000_create_roles`), `Permission` (tabela global `permissions`, migration `20261002060000_create_permissions`), `RolePermission` (tabela `role_permissions`, migration `20261002070000_create_role_permissions`), `UserRole` (tabela `user_roles`, migration `20261002080000_create_user_roles`), `Device` (tabela `devices`, migration `20261002090000_create_devices`), `Session` (tabela `sessions`, migration `20261002100000_create_sessions`) e `AuditLog` (tabela `audit_logs`, migrations `20261002110000_create_audit_logs` e `20261002111000_make_audit_logs_append_only`). A imutabilidade de `tenant_id` é imposta pela migration `20261002120000_make_tenant_id_immutable` (M1.14.1); o bloqueio de `TRUNCATE` em `audit_logs`, pela `20261002121000_forbid_audit_logs_truncate` (M1.14.2a); a remoção do índice redundante `companies_tenant_id_idx`, pela `20261002130000_drop_redundant_company_tenant_index` (M1.14.3). No M2: `tenants.login_code` pela `20261012000000_add_tenant_login_code` e o formato normalizado de `users.employee_number` pela `20261012010000_enforce_employee_number_format`. No M3: CNPJ alfanumérico pela `20261107000000_allow_alphanumeric_cnpj`. No M4: catálogo de produtos (`ProductCategory`, `Product`, `ProductOptionGroup`, `ProductOption`, `BranchProductSetting`) pela `20261108000000_create_product_catalog` (seção "Catálogo de produtos (M4)"). No M5: pedidos (`Order`, `OrderItem`, `OrderItemOption`, `BranchOrderCounter`) pela `20261109000000_create_orders` (seção "Pedidos do PDV (M5)"). No M6: caixa e pagamentos (`CashSession`, `CashMovement`, `Payment`, `Refund`) pela `20261110000000_create_cash_and_payments` e o ajuste da imutabilidade de venda do M5 pela `20261110010000_adjust_order_immutability` (seção "Caixa e pagamentos (M6)"). A URL de conexão vem de `DATABASE_URL` (lida em `apps/api/prisma.config.ts`), nunca do código. Identidades e privilégios do PostgreSQL (`erp_migrator`/`erp_app`, M1.14.2b): seção "Identidades e privilégios do PostgreSQL" abaixo.

## Tenant
Raiz do multi-tenancy; por isso **não** possui `tenant_id`.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `name` | `text` | não | |
| `status` | enum `tenant_status` | não | `TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED`, `CANCELLED`; sem default |
| `trial_started_at` | `timestamptz(3)` | sim | |
| `trial_ends_at` | `timestamptz(3)` | sim | TRIAL autentica só enquanto nulo ou futuro (M2) |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz(3)` | não | mantido pelo Prisma (`@updatedAt`) |

| `login_code` | `text` | sim | código **público** de login da organização (M2): não é segredo, só resolve o tenant antes do login; `UNIQUE` global (`tenants_login_code_key`); CHECK `^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$`; nulo = sem login por código (coluna física no fim da tabela) |

Sem soft delete, billing ou RLS. Status que autenticam: ver [security.md](security.md).

## Company
Empresa de um tenant. Relação **Tenant 1 → N Company**; o MVP começa com uma empresa por tenant, mas **não** há constraint 1:1.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client (mesma estratégia do Tenant) |
| `tenant_id` | `uuid` | não | FK `tenants.id`, `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `legal_name` | `text` | não | CHECK `btrim(legal_name) <> ''` |
| `trade_name` | `text` | não | CHECK `btrim(trade_name) <> ''` |
| `cnpj` | `text` | não | sem máscara, maiúsculo, numérico ou alfanumérico (M3); CHECK `cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'`; `UNIQUE (tenant_id, cnpj)` |
| `status` | enum `company_status` | não | `ACTIVE`, `INACTIVE`; sem default |
| `timezone` | `text` | não | nome IANA (ex.: `America/Sao_Paulo`); **não validado no banco** |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz(3)` | não | mantido pelo Prisma (`@updatedAt`) |

- Índices: `(tenant_id, status)`, a unique `(tenant_id, cnpj)` e a unique `(tenant_id, id)` (alvo da FK composta de Branch, criada na migration de Branch). O índice isolado `(tenant_id)` (`companies_tenant_id_idx`) foi **removido no M1.14.3**: era redundante, pois os três índices acima começam por `tenant_id` e cobrem a FK para `tenants` e as consultas por tenant.
- CNPJ não é globalmente único. **Formato (M3, migration `20261107000000_allow_alphanumeric_cnpj`):** 12 caracteres `[0-9A-Z]` + 2 dígitos verificadores numéricos, cobrindo o CNPJ alfanumérico emitido pela Receita Federal desde 31/07/2026 (IN RFB 2.229/2024) e o numérico (superconjunto: nenhum dado existente muda). Os dígitos verificadores (módulo 11, valor = ASCII − 48) são validados **só na aplicação** (`apps/api/src/organization/validation/cnpj.ts`), que também remove a máscara e passa para maiúsculo. Imutável pela API depois de criado.
- Os CHECKs de nome rejeitam vazio e somente espaços (`btrim` remove apenas o caractere espaço).
- Remoção física de um Tenant com Company falha (FK `RESTRICT`); sem cascade e sem soft delete.

## Branch
Filial/unidade física. Pertence a uma Company **e** ao mesmo Tenant dessa Company. Relações **Tenant 1 → N Branch** e **Company 1 → N Branch**; `tenant_id` é explícito (isolamento e performance), mesmo sendo derivável via Company.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `company_id` | `uuid` | não | FK composta `(tenant_id, company_id)` → `companies(tenant_id, id)` (`RESTRICT`) |
| `name` | `text` | não | CHECK `btrim(name) <> ''` |
| `code` | `text` | não | código operacional (ex.: `MORUMBI`); CHECK `btrim(code) <> ''`; `UNIQUE (tenant_id, code)`; sem regra de formato/caixa no banco |
| `cnpj` | `text` | sim | CHECK `cnpj IS NULL OR cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'` (M3, mesmo formato da Company); `UNIQUE (tenant_id, cnpj)` |
| `status` | enum `branch_status` | não | `ACTIVE`, `INACTIVE`; sem default |
| `timezone` | `text` | não | nome IANA; **não validado no banco** |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz(3)` | não | mantido pelo Prisma (`@updatedAt`) |

- Índices: `(tenant_id, company_id)` (também atende a FK composta), `(tenant_id, status)` e as uniques `(tenant_id, code)`, `(tenant_id, cnpj)` e `(tenant_id, id)` (alvo da FK composta de UserBranchAccess, criada no M1.6). Sem índice isolado em `tenant_id`: todos os compostos começam por ele.
- `code` é único por tenant (não por company): duas companies do mesmo tenant não repetem código. A unique compara o texto exato; a camada de aplicação (futura) normalizará o código com **trim + uppercase** antes de gravar, de modo que `morumbi ` e `MORUMBI` não coexistam. A API (M3) normaliza com trim + uppercase e valida `^[A-Z0-9][A-Z0-9_-]{0,31}$` (formato confirmado como decisão de produto no M3); o banco segue sem regra de formato.
- CNPJ nulo: a unique usa o padrão `NULLS DISTINCT` do PostgreSQL, logo várias branches sem CNPJ são aceitas e CNPJ preenchido não se repete no tenant. Não é globalmente único. O banco não compara com o CNPJ da Company; a API (M3) exige a mesma raiz (8 primeiros caracteres) da Company.
- Remoção física de Tenant ou Company com Branch falha (`RESTRICT`); sem cascade e sem soft delete.

### Integridade Tenant/Company (padrão para entidades filhas)
A FK simples `company_id → companies.id` não impede `branches.tenant_id` diferente de `companies.tenant_id`. Por isso:
1. `companies` tem `UNIQUE (tenant_id, id)` (redundante para unicidade, já que `id` é PK, mas necessário como alvo de FK);
2. `branches` referencia `(tenant_id, company_id) → companies(tenant_id, id)`.

O banco então rejeita, por Prisma ou SQL direto: criar Branch do Tenant A com Company do Tenant B; trocar só `company_id` ou só `tenant_id` da Branch para outro tenant; trocar `tenant_id` de uma Company que tem Branches (`ON UPDATE RESTRICT`). Os testes de integração verificam esses casos e que a versão com FK simples falharia. Entidades futuras que referenciem Company/Branch devem seguir o mesmo padrão.

## User
Funcionário individual do tenant (sem usuários compartilhados). Login no PDV por **matrícula + senha** (M2, [security.md](security.md)): `password_hash` = Argon2id PHC; `failed_login_attempts`/`locked_until` = lockout temporário persistido; `last_login_at` gravado no login; `status`/`disabled_at` nunca alterados pelo Auth. Relação **Tenant 1 → N User**.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id`, `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `name` | `text` | não | CHECK `btrim(name) <> ''` |
| `employee_number` | `text` | não | matrícula normalizada (M2): CHECK `employee_number ~ '^[A-Z0-9._-]{1,32}$'` (trim + uppercase feitos pela aplicação; zeros à esquerda preservados); `UNIQUE (tenant_id, employee_number)`; sem formato numérico imposto |
| `password_hash` | `text` | não | **somente o hash**, gravado sem transformação; CHECK `btrim(password_hash) <> ''` |
| `status` | enum `user_status` | não | `ACTIVE`, `DISABLED` (desativação administrativa), `LOCKED` (bloqueio de segurança); sem default |
| `must_change_password` | `boolean` | não | default `false` |
| `failed_login_attempts` | `integer` | não | default `0`; CHECK `>= 0` |
| `locked_until` | `timestamptz(3)` | sim | |
| `last_login_at` | `timestamptz(3)` | sim | |
| `disabled_at` | `timestamptz(3)` | sim | |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz(3)` | não | mantido pelo Prisma (`@updatedAt`) |

- Índices: unique `(tenant_id, employee_number)`, `(tenant_id, status)` e unique `(tenant_id, id)` (alvo da FK composta de UserBranchAccess, criada no M1.6).
- **Matrícula única por tenant**, não global: a mesma matrícula pode existir em outro tenant. Comparação exata do valor normalizado (`normalizeEmployeeNumber`, mesma regra no cadastro e no login).
- **Senha nunca é persistida em texto puro.** Não existe coluna `password`, `plain_password`, `temporary_password` nem equivalente; a auditoria do catálogo falha se surgir coluna textual com nome de credencial além de `users.password_hash`. O algoritmo (previsão: Argon2id) pertence ao M2.
- **Sem exclusão física no fluxo normal:** o usuário é desativado (`status = DISABLED`) e permanece no histórico. Sem soft delete universal e sem cascade; Tenant com User não pode ser apagado.
- Coerência entre `status` e `disabled_at`/`locked_until` **não** é imposta no banco (ex.: reativação, bloqueio sem prazo); fica para a camada de aplicação (Auth/M2).

## UserBranchAccess
Define quais filiais um usuário pode acessar: **User 0..N Branches, sempre no mesmo Tenant**. É **separado de papel/permissão**: dizer que o usuário acessa a filial não diz o que ele pode fazer nela. Roles por filial são atribuídas em `UserRole` (M1.10), que exige este vínculo. Relações Tenant/User/Branch **1 → N** UserBranchAccess.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `user_id` | `uuid` | não | FK composta `(tenant_id, user_id)` → `users(tenant_id, id)` (`RESTRICT`) |
| `branch_id` | `uuid` | não | FK composta `(tenant_id, branch_id)` → `branches(tenant_id, id)` (`RESTRICT`) |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |

- Sem `updated_at`, status, `revoked_at` ou `expires_at`: o vínculo existe ou não existe. Validade temporária será evolução explícita.
- `UNIQUE (tenant_id, user_id, branch_id)`: o mesmo acesso não é concedido duas vezes; também atende consultas por usuário e a FK composta de User. Índice `(tenant_id, branch_id)` para listar usuários de uma filial (e atender a FK composta de Branch).
- O banco rejeita, por Prisma ou SQL: User de outro tenant, Branch de outro tenant, User e Branch de tenants diferentes, e alterações posteriores de `user_id`, `branch_id` ou só `tenant_id` que criem combinação cross-tenant.
- User ou Branch com acesso não pode ser apagado (`RESTRICT`), coerente com a política de desativação; também não pode mudar de tenant (`ON UPDATE RESTRICT` nas FKs compostas).
- Um acesso usado por uma `UserRole` escopada àquela filial não pode ser removido antes dela (M1.10).
- Sem regra de "filial padrão", convite ou expiração.

## Role
Catálogo de papéis do RBAC, **pertencente ao Tenant**. Sozinha, uma Role **não concede permissão alguma**: as permissões vêm de `RolePermission` e a atribuição a usuários de `UserRole`, resolvidas pelo `AuthorizationService` (M2; só roles `ACTIVE` concedem). Relação **Tenant 1 → N Role**.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id`, `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `code` | `text` | não | identificador técnico; CHECK `btrim(code) <> ''`; `UNIQUE (tenant_id, code)`; sem uppercase imposto no banco |
| `name` | `text` | não | nome exibido; CHECK `btrim(name) <> ''` |
| `description` | `text` | sim | |
| `is_system` | `boolean` | não | default `false`; `true` = template provisionado pelo sistema, `false` = role customizada do cliente |
| `status` | enum `role_status` | não | `ACTIVE` (utilizável), `INACTIVE` (temporariamente indisponível), `ARCHIVED` (retirada de uso, mantém histórico); sem default |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz(3)` | não | mantido pelo Prisma (`@updatedAt`) |

- Índices: unique `(tenant_id, code)`, `(tenant_id, status)` e unique `(tenant_id, id)` (alvo da FK composta de RolePermission, criada no M1.9; não cria regra funcional, `id` já é PK).
- **Códigos padrão previstos** (templates, `is_system = true`): `OWNER` (Proprietário), `MANAGER` (Gerente), `ATTENDANT` (Atendente), `KITCHEN` (Cozinha). Criados pelo provisionamento do Tenant (`TenantProvisioningService`, M2.11, idempotente); **não há seed global**. A matriz de permissões aprovada está em `DEFAULT_ROLE_PERMISSIONS` ([security.md](security.md)). O banco não reserva esses códigos: hoje uma role customizada poderia usar `OWNER` se o código ainda não existir no tenant.
- **Roles customizadas** são suportadas (`is_system = false`, código livre e único por tenant). A aplicação poderá normalizar `code` (trim + uppercase) no futuro.
- Sem regras de edição/exclusão de role de sistema ainda. Sem exclusão física como operação normal: roles são desativadas ou arquivadas; Tenant com Role não pode ser apagado (`RESTRICT`).
- A Role não tem filial; o escopo por filial fica na atribuição (`user_roles.branch_id`).

## Permission (global)
Catálogo técnico **global** de capacidades do sistema; **não pertence a um Tenant** (Role é por Tenant). Controlado pelo sistema: sem CRUD por cliente, sem permissões customizadas. A ligação Role ↔ Permission é feita por `RolePermission` (abaixo).

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `code` | `text` | não | `UNIQUE (code)` global; CHECK `code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'` |
| `module` | `text` | não | agrupamento funcional (texto, sem enum); CHECK `btrim(module) <> ''` |
| `description` | `text` | não | CHECK `btrim(description) <> ''` |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |

- Sem `tenant_id`, `updated_at`, status, soft delete ou FK: só a definição técnica (nada de usuário, role, regra condicional ou escopo de filial).
- Índices: unique `(code)` e `(module)` para consultas por módulo.
- **Formato de `code`:** `<module>.<action>`, minúsculas ASCII, dígitos e `_`, dois ou mais segmentos separados por ponto, sem espaços (ex.: `branch.read`, `order.item.cancel`). O prefixo do código não precisa ser igual a `module` (ex.: `branch.read` está no módulo `organization`).
- **`code` é identificador técnico estável:** o código da aplicação dependerá dele. Renomear exige migração coordenada (vínculos e código), não uma simples edição. Não há trigger impedindo.
- **Catálogo inicial** (19 permissões, módulos `organization`, `users`, `products`, `orders`, `cash`, `fiscal`): `organization.read|manage`, `branch.read|manage`, `user.read|manage`, `role.read|manage`, `product.read|manage`, `order.read|create|cancel`, `cash.read|open|close`, `fiscal.read|issue|cancel`. Definido em `apps/api/src/database/seed/permissions.ts`.

### Seed
- `npm run db:seed` (ou `prisma db seed`): compila com `nest build` e executa `dist/database/seed.js` contra `DATABASE_URL`. Sem `tsx`. Roda no deploy como `erp_migrator` (`erp_app` só lê `permissions`).
- **Idempotente:** `upsert` por `code`; cria o que falta, realinha `module`/`description` ao catálogo e **nunca** troca o `id` (UUIDv7 gerado na primeira inserção) nem remove permissões que saíram do catálogo.

## RolePermission
Permissões concedidas a uma Role: **Role N ↔ N Permission**. **Permission é global, Role é por Tenant e RolePermission é por Tenant.** Não liga Role a User (UserRole é outro módulo). Relações Tenant/Role/Permission **1 → N** RolePermission.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `role_id` | `uuid` | não | **FK composta** `(tenant_id, role_id)` → `roles(tenant_id, id)` (`RESTRICT`): a Role é sempre do mesmo tenant |
| `permission_id` | `uuid` | não | **FK simples** → `permissions(id)` (`RESTRICT`): válida porque Permission é global e compartilhada por todos os tenants |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |

- Sem `updated_at` e sem `permission_code` duplicado: a identidade da permissão é a linha em `permissions`.
- `UNIQUE (tenant_id, role_id, permission_id)`: a mesma permissão não é atribuída duas vezes à mesma role; também lista as permissões de uma role e atende a FK composta.
- Índice `(permission_id)`: consulta inversa (quais roles, em qualquer tenant, usam a permissão; manutenção do catálogo) e checagem do `RESTRICT` ao apagar uma permissão. Escolhido em vez de `(permission_id, tenant_id)` por simplicidade: consultas por tenant partem da role, já cobertas pela unique.
- O banco rejeita, por Prisma ou SQL: Role de outro tenant; troca posterior de `role_id` para Role de outro tenant; troca só de `tenant_id`. A mesma Permission pode, naturalmente, estar em roles de vários tenants.
- **Remoção com `RESTRICT`:** Role com permissões não pode ser apagada nem mudar de tenant; **Permission vinculada não pode ser apagada** (uma permissão que sair do catálogo exigirá remover os vínculos explicitamente, política ainda não definida); Tenant com RolePermission não pode ser apagado.
- **Provisionamento (M2):** `TenantProvisioningService` acrescenta os vínculos da matriz aprovada das roles padrão (OWNER = 19, MANAGER = 16, ATTENDANT = 8, KITCHEN = 2), de forma idempotente; nunca remove vínculos. Permissão nova do catálogo não entra em role alguma até decisão explícita na matriz.

## UserRole
Role atribuída a um User, **global ou por filial**. Relações Tenant/User/Role **1 → N** UserRole; UserBranchAccess **1 → N** UserRole escopadas.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `user_id` | `uuid` | não | FK composta `(tenant_id, user_id)` → `users(tenant_id, id)` (`RESTRICT`) |
| `role_id` | `uuid` | não | FK composta `(tenant_id, role_id)` → `roles(tenant_id, id)` (`RESTRICT`) |
| `branch_id` | `uuid` | **sim** | `NULL` = role válida em **todo o tenant**; preenchido = válida **só naquela filial**. FK composta `(tenant_id, user_id, branch_id)` → `user_branch_access(tenant_id, user_id, branch_id)` (`RESTRICT`) |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |

- **Escopo do tenant:** `branch_id IS NULL` tem significado explícito; sem filial fictícia nem UUID sentinela, e não exige UserBranchAccess.
- **Escopo de filial exige UserBranchAccess**, garantido pelo banco: a FK para `user_branch_access` é `MATCH SIMPLE` (padrão do PostgreSQL), então é verificada quando `branch_id` está preenchido e ignorada quando é `NULL`. Como `tenant_id` e `user_id` são `NOT NULL`, só `branch_id` pode desligar essa FK (a auditoria verifica). Ela garante ao mesmo tempo que a filial existe, é do mesmo tenant e que o usuário tem acesso a ela, por isso **não há FK direta para `branches`** (seria redundante).
- **Unicidade por índices únicos parciais** (criados à mão na migration; o Prisma 7.10 não representa índices parciais e o `migrate diff` os ignora, então só os testes de catálogo os protegem):
  - `user_roles_tenant_scope_key (tenant_id, user_id, role_id) WHERE branch_id IS NULL`: impede a mesma role global duas vezes. Uma unique comum `(tenant_id, user_id, role_id, branch_id)` não bastaria, porque o PostgreSQL considera NULLs distintos;
  - `user_roles_branch_scope_key (tenant_id, user_id, role_id, branch_id) WHERE branch_id IS NOT NULL`: a mesma role uma vez por filial.
- **Global e específica podem coexistir** (ex.: MANAGER global e MANAGER na filial A). O banco não bloqueia; a autorização futura poderá tratar a global como abrangente e a específica como redundante.
- Índices não parciais: `(tenant_id, user_id, branch_id)` para listar as roles de um usuário (todas ou numa filial, `branch_id = X OR branch_id IS NULL`) e atender as FKs para `users` e `user_branch_access`; `(tenant_id, role_id)` para listar usuários de uma role e atender a FK para `roles`. Os índices parciais não servem a consultas sem filtro de escopo, por isso não substituem esses dois. Não há índice `(tenant_id, branch_id)` (listar atribuições por filial não é necessário ainda).
- **Remoção com `RESTRICT`:** User com UserRole, Role atribuída e Tenant com UserRole não podem ser apagados; o UserBranchAccess usado por uma role escopada só pode ser removido depois dela. Role global não prende nenhum acesso.
- **Para alterar uma atribuição, a aplicação deve apagar o vínculo e criar outro**, em vez de transformar o existente (trocar `role_id`/`branch_id` dentro do tenant é aceito pelo banco, mas não é o fluxo previsto).

## Device
Terminal/dispositivo conhecido pelo ERP (PDV, tablet, terminal administrativo, display de cozinha, Edge futuro). **Pertence ao Tenant**; a filial é opcional. Relações Tenant **1 → N** Device e Branch **1 → N** Device. Apenas estrutura: **sem pairing, autenticação de dispositivo, certificado, segredo ou heartbeat**.

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `branch_id` | `uuid` | **sim** | `NULL` = dispositivo de nível do tenant; preenchido = da filial. FK composta `(tenant_id, branch_id)` → `branches(tenant_id, id)` (`RESTRICT`) |
| `name` | `text` | não | CHECK `btrim(name) <> ''` |
| `device_type` | enum `device_type` | não | `POS`, `TABLET`, `ADMIN`, `KITCHEN_DISPLAY`, `EDGE` |
| `device_key` | `text` | não | identificador técnico estável no tenant; CHECK `btrim(device_key) <> ''`; `UNIQUE (tenant_id, device_key)` |
| `status` | enum `device_status` | não | `ACTIVE` (habilitado), `INACTIVE` (fora de uso temporário), `REVOKED` (confiança/acesso revogado); sem default |
| `last_seen_at` | `timestamptz(3)` | sim | atualização futura por heartbeat/atividade; nada o atualiza hoje |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz(3)` | não | mantido pelo Prisma (`@updatedAt`) |

- **Filial opcional:** a FK composta é `MATCH SIMPLE`, verificada quando `branch_id` está preenchido (filial existe e é do mesmo tenant) e ignorada quando é `NULL`. Sem filial sentinela.
- **`device_key` não é segredo:** é só um identificador técnico, sem geração automática. Não guarda token, senha, API key ou certificado. Segredos de dispositivo, se necessários, virão em módulo próprio e nunca em texto puro; a tabela não tem nenhuma coluna desse tipo (teste de catálogo específico + auditoria global de credenciais).
- **`EDGE` é só um tipo estrutural** nesta etapa; o Edge Server não está implementado ([offline-edge.md](offline-edge.md)).
- Índices: unique `(tenant_id, device_key)`, `(tenant_id, status)`, `(tenant_id, branch_id)` (listagem por filial e lookup da FK para `branches`; não coberto pelos outros dois) e unique `(tenant_id, id)` (alvo da FK composta de Session, criada no M1.12).
- Sem soft delete: o fluxo normal usa `INACTIVE`/`REVOKED`. Branch ou Tenant com Device não podem ser apagados; Branch com Device também não pode mudar de tenant (`ON UPDATE RESTRICT`).

## Session
Registro persistente de sessão, base para o módulo Auth (M2): sessões revogáveis, refresh tokens rotativos, encerramento administrativo. **Pertence a User e Tenant**; o Device é opcional. Usada pelo Auth (M2): `refresh_token_hash` = `sha256$...` do segredo de 256 bits do refresh token, rotação por UPDATE condicional, revogação por `revoked_at` (logout, replay, troca/reset de senha, admin); ver [security.md](security.md). **Sem migration nova no M2.**

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `user_id` | `uuid` | não | FK composta `(tenant_id, user_id)` → `users(tenant_id, id)` (`RESTRICT`) |
| `device_id` | `uuid` | **sim** | sessão com ou sem dispositivo conhecido; FK composta `(tenant_id, device_id)` → `devices(tenant_id, id)` (`RESTRICT`, `MATCH SIMPLE`: verificada só quando preenchido, sempre do mesmo tenant) |
| `refresh_token_hash` | `text` | não | **somente o hash** do refresh token atual; `UNIQUE` **global**; CHECK `btrim(refresh_token_hash) <> ''` |
| `ip_address` | `inet` | sim | tipo nativo do PostgreSQL (`String @db.Inet` no Prisma 7.10, sem `Unsupported`); o banco rejeita IP inválido |
| `user_agent` | `text` | sim | só metadado de contexto, nunca identificador de segurança; sem índice |
| `expires_at` | `timestamptz(3)` | não | **sem default**: quem cria a sessão informa a expiração; CHECK `expires_at > created_at` |
| `revoked_at` | `timestamptz(3)` | sim | `NULL` = não revogada |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |

- **Estado derivado**, sem enum de status, `is_revoked` ou `updated_at`: ativa = `revoked_at IS NULL AND expires_at > now()`; revogada = `revoked_at IS NOT NULL`; expirada = `expires_at <= now()`. Revogação pode ocorrer antes ou depois da expiração (sem constraint entre as duas).
- **`refresh_token_hash` é globalmente único** (sem `tenant_id`): dois registros nunca compartilham token, a autenticação futura localiza a sessão direto pelo hash e um token rotacionado não identifica duas sessões. O token será aleatório o bastante (M2) para não depender de escopo por tenant.
- **Nunca persistir refresh token puro nem access token.** Não existem colunas `refresh_token`, `token` ou `access_token`; a auditoria de credenciais as rejeita.
- **CHECK `expires_at > created_at`**: compara valores da própria linha (com o default, `created_at` é o início da transação), então não depende de ordem de avaliação. Fixtures de sessões já expiradas precisam informar também um `created_at` anterior.
- Índices: unique `(refresh_token_hash)`, `(tenant_id, user_id)` (sessões do usuário e FK para `users`) e `(tenant_id, device_id)` (sessões do dispositivo e FK para `devices`). Sem índice em `expires_at` por enquanto.
- **Rotação (M2):** a sessão guarda apenas o hash do refresh token válido, substituído por UPDATE condicional (`refresh_token_hash = <apresentado> AND revoked_at IS NULL AND expires_at > agora`). Sem histórico/token family e sem coluna nova: o refresh token carrega uma prova HMAC de que foi emitido pelo servidor para aquela sessão; só um token com prova válida cujo segredo não é o atual é tratado como replay e revoga a sessão (token forjado é apenas inválido).
- **Remoção com `RESTRICT`:** User, Device e Tenant com sessão não são apagados; User ou Device com sessão também não mudam de tenant. Retenção/LGPD das sessões históricas ainda será definida.

## AuditLog
Trilha histórica **append-only** de eventos relevantes do tenant: segurança, administração, operação, alterações sensíveis, ações de usuário, de dispositivo e automáticas do sistema. **Pertence ao Tenant**; usuário, filial e dispositivo são opcionais. Apenas a estrutura persistente: **nenhum controller, service ou worker grava eventos ainda** (instrumentação e `AuditService` são etapas futuras).

| Coluna | Tipo PostgreSQL | Nulo | Observação |
|---|---|---|---|
| `id` | `uuid` (PK) | não | UUIDv7 gerado pelo Prisma Client |
| `tenant_id` | `uuid` | não | FK `tenants.id` (`RESTRICT`) |
| `user_id` | `uuid` | **sim** | ator humano, quando houver. FK composta `(tenant_id, user_id)` → `users(tenant_id, id)` (`RESTRICT`, `MATCH SIMPLE`) |
| `branch_id` | `uuid` | **sim** | filial do evento, quando houver. FK composta `(tenant_id, branch_id)` → `branches(tenant_id, id)` (`RESTRICT`, `MATCH SIMPLE`) |
| `device_id` | `uuid` | **sim** | dispositivo de origem, quando houver. FK composta `(tenant_id, device_id)` → `devices(tenant_id, id)` (`RESTRICT`, `MATCH SIMPLE`) |
| `action` | `text` | não | ação técnica (sem enum); CHECK `action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'` |
| `resource_type` | `text` | não | tipo lógico do recurso afetado (sem enum); CHECK `resource_type ~ '^[a-z][a-z0-9_]*$'` |
| `resource_id` | `uuid` | sim | referência **lógica/polimórfica**, **sem FK** (abaixo) |
| `metadata` | `jsonb` | sim | contexto adicional; **nunca** credenciais (abaixo) |
| `ip_address` | `inet` | sim | mesmo padrão de `sessions.ip_address` (`String @db.Inet`); o banco rejeita IP inválido |
| `created_at` | `timestamptz(3)` | não | default `CURRENT_TIMESTAMP` |

- **Append-only, imposto pelo PostgreSQL** (migrations `20261002111000_make_audit_logs_append_only` e `20261002121000_forbid_audit_logs_truncate`): sem `updated_at`, `deleted_at`, status ou soft delete, e **`UPDATE`, `DELETE` e `TRUNCATE` são bloqueados fisicamente**. `INSERT` continua livre.
  - Função `forbid_audit_log_mutation()` (`plpgsql`, `RETURNS trigger`): sempre lança `AuditLog is append-only: <TG_OP> on audit_logs is not allowed` (SQLSTATE `P0001`, com `HINT`), com `TG_OP` = `UPDATE`, `DELETE` ou `TRUNCATE`. Reutilizada **sem alteração** pelo trigger de TRUNCATE: como nunca retorna normalmente e já informa a operação, serve a row e statement triggers.
  - Trigger `audit_logs_append_only`: `BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW`. Rejeita qualquer UPDATE (inclusive no-op `SET x = x` e em massa) e qualquer DELETE, via Prisma ou SQL; a transação que tenta falha e a linha fica intacta.
  - Trigger `audit_logs_no_truncate`: `BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT` (row triggers não disparam em TRUNCATE). Rejeita `TRUNCATE`, `TRUNCATE TABLE`, `ONLY`, `RESTART`/`CONTINUE IDENTITY`, `CASCADE`/`RESTRICT` e também o TRUNCATE em cascata a partir de uma tabela pai (ex.: `TRUNCATE tenants CASCADE`, que alcançaria `audit_logs` pela FK); a tabela fica intacta e a transação é desfeita.
  - **Específicos de `audit_logs`:** a função não deve ser reutilizada em outra tabela (a auditoria do catálogo exige que ela só apareça em `audit_logs`, e exatamente nos dois triggers aprovados). **Não é** o trigger genérico de imutabilidade de `tenant_id` (M1.14.1): aquele bloqueia só a troca de `tenant_id` em tabelas que continuam editáveis; este bloqueia toda mutação de uma tabela que não é editável, e por isso `audit_logs` não recebe o genérico.
  - Como o BEFORE trigger dispara antes das FKs, um UPDATE em `audit_logs` falha pelo append-only, nunca pela FK. As FKs compostas continuam sendo a segunda barreira: testes desabilitam o trigger dentro de uma transação desfeita e provam que vínculos cross-tenant ainda são rejeitados.
  - **Fronteira desta proteção:** vale para operações normais com triggers ativos. Desde o M1.14.2b a aplicação roda como `erp_app`, que não tem `UPDATE`/`DELETE`/`TRUNCATE` em `audit_logs` (segunda camada, independente dos triggers), não é dona da tabela nem das funções e não consegue desabilitar triggers, alterar funções, executar DDL ou `SET session_replication_role`. O dono (`erp_migrator`, só no pipeline de deploy) e a identidade admin continuam capazes disso; ver "Identidades e privilégios do PostgreSQL".
- **Ator e contexto opcionais, sem sentinela:** `user_id NULL` = evento sem usuário (worker, rotina automática, evento sistêmico, evento só de dispositivo); não existe usuário fictício `SYSTEM`. `branch_id`/`device_id` `NULL` = sem filial/dispositivo. As três FKs compostas são `MATCH SIMPLE` (padrão do PostgreSQL): verificadas quando a coluna está preenchida e ignoradas quando é `NULL`; preenchidas, garantem existência e mesmo tenant. Não há regra entre elas (ex.: o banco não exige que o dispositivo seja da filial informada).
- **`action`** (ex.: `user.created`, `role.assigned`, `session.revoked`, `order.item.cancelled`): mesmo formato de `permissions.code`: minúsculas ASCII, dígitos e `_`, dois ou mais segmentos separados por ponto, cada um começando por letra. Rejeita maiúsculas, espaços, ponto inicial/final, segmento vazio e segmento único. `$` no regex do PostgreSQL casa só no fim do texto, então um `\n` final também é rejeitado. **Sem catálogo de ações no banco** (nem enum, nem tabela).
- **`resource_type`** (ex.: `user`, `role`, `device`, `session`, `order`, `payment`, `fiscal_document`): um único segmento, minúsculas, dígitos e `_`, começando por letra.
- **`resource_id` sem FK, de propósito:** (1) o recurso pode ser de qualquer tipo, atual ou futuro; (2) o log precisa sobreviver ao ciclo de vida do recurso (ex.: um vínculo apagado continua auditável); (3) o PostgreSQL não tem FK polimórfica, e as alternativas (uma coluna/FK por tipo, tabela de supertipo, triggers genéricos) foram descartadas. Consequências: o banco não garante que o recurso existe nem que é do mesmo tenant; `resource_type` + `resource_id` são uma referência informativa, e a camada de aplicação é responsável por gravá-los corretamente. Tipo `uuid` porque todos os IDs do sistema são UUIDv7; recurso sem UUID fica com `resource_id NULL` e identificação em `metadata`.
- **`metadata` não é local permitido para credenciais.** Nunca gravar conscientemente: senha, `password_hash`, refresh token, `refresh_token_hash`, access token, API key, segredo, chave privada, PIN, dados completos de cartão. Nesta etapa **não há sanitizador automático** de JSON nem CHECK de conteúdo; a futura camada `AuditService` deverá filtrar/mascarar antes de gravar. A auditoria de credenciais do catálogo verifica só **nomes de colunas** (`metadata` não casa), não o conteúdo do JSON. Também não há restrição de forma (objeto, array ou escalar são aceitos) nem de tamanho. `NULL` SQL e `null` JSON são distintos: no Prisma, omitir o campo ou usar `Prisma.DbNull` grava `NULL` SQL.
- **Índices** (todos começam por `tenant_id`; `created_at` no fim para ordenar a linha do tempo):
  - `(tenant_id, created_at)`: linha do tempo do tenant;
  - `(tenant_id, user_id, created_at)`, `(tenant_id, branch_id, created_at)`, `(tenant_id, device_id, created_at)`: ações por usuário, filial e dispositivo; também atendem a checagem `RESTRICT` das FKs compostas;
  - `(tenant_id, resource_type, resource_id, created_at)`: histórico de um recurso.
  - Sem índice em `action` ou GIN em `metadata` por enquanto. É uma tabela de escrita intensa: cada índice novo deve ser justificado por consulta real.
- **Remoção com `RESTRICT`:** User, Branch, Device e Tenant referenciados por um log não podem ser apagados (coerente com a política de desativação e com "auditoria nunca é apagada fisicamente"); também não mudam de tenant (`ON UPDATE RESTRICT`).
- Retenção, particionamento, arquivamento e LGPD de `ip_address`/`metadata` ainda serão definidos.

## Catálogo de produtos (M4)
Cardápio **único por tenant**; cada filial só desliga o produto e/ou sobrescreve o preço. Variação, adicional e combo são **grupos de opções** do produto. Migration `20261108000000_create_product_catalog`. Todas as tabelas são de tenant (`tenant_id uuid NOT NULL`, FK direta para `tenants`, UUIDv7, `created_at`/`updated_at` `timestamptz(3)`, trigger `<tabela>_tenant_id_immutable`), com FKs compostas `(tenant_id, x_id)` `ON DELETE/UPDATE RESTRICT` (sem CASCADE). Campos fiscais (NCM, CFOP, CEST, origem, tributação) **não** estão aqui: entram no M9.

| Tabela | Colunas principais | FKs compostas | Uniques / índices | CHECKs |
|---|---|---|---|---|
| `product_categories` | `name`, `sort_order int` (default 0), `status product_category_status` | — | `(tenant_id, id)` (alvo de `products`); `(tenant_id, status)` | `btrim(name) <> ''`; `sort_order` 0..9999 |
| `products` | `category_id` (nulo), `name`, `description` (nulo), `code` (nulo), `base_price numeric(12,2)`, `sort_order`, `status product_status` | `(tenant_id, category_id)` → `product_categories` (`MATCH SIMPLE`: nulo = sem categoria) | `(tenant_id, code)` (NULLS DISTINCT); `(tenant_id, id)` (alvo de grupos, combo e ajustes); `(tenant_id, status)`; `(tenant_id, category_id)` | nome não vazio; descrição nula ou não vazia; `code` nulo ou `^[A-Z0-9][A-Z0-9_-]{0,31}$` (formato de `branches.code`); `base_price >= 0`; `sort_order` 0..9999 |
| `product_option_groups` | `product_id`, `name`, `min_choices`, `max_choices`, `sort_order` | `(tenant_id, product_id)` → `products` | `(tenant_id, product_id, sort_order)` (ordem única; cobre a FK); `(tenant_id, product_id, id)` (alvo da FK das opções) | nome; `min_choices >= 0`; `max_choices >= 1`; `min_choices <= max_choices`; `sort_order` 0..9999 |
| `product_options` | `product_id`, `group_id`, `name`, `price_delta numeric(12,2)`, `linked_product_id` (nulo = opção simples), `sort_order` | `(tenant_id, product_id, group_id)` → `product_option_groups(tenant_id, product_id, id)`; `(tenant_id, linked_product_id)` → `products` (`MATCH SIMPLE`) | `(tenant_id, product_id, group_id, sort_order)` (ordem única; cobre a FK do grupo); `(tenant_id, linked_product_id)` | nome; `price_delta >= 0`; `sort_order` 0..9999; `linked_product_id IS NULL OR linked_product_id <> product_id` |
| `branch_product_settings` | `branch_id`, `product_id`, `available boolean`, `price numeric(12,2)` (nulo = preço base) | `(tenant_id, branch_id)` → `branches`; `(tenant_id, product_id)` → `products` | `(tenant_id, branch_id, product_id)` (um ajuste por produto/filial; cobre a FK da filial); `(tenant_id, product_id)` | `price IS NULL OR price >= 0` |

- **`product_options.product_id`** é cópia do produto do grupo, **garantida pela FK composta** `(tenant_id, product_id, group_id)` → `product_option_groups(tenant_id, product_id, id)`: não diverge. Serve para o CHECK de auto-vínculo (opção não vincula o próprio produto, sem trigger) e para a substituição em bloco por produto.
- **Dinheiro:** `numeric(12,2)` em reais (máximo `9999999999.99`; um 11º dígito inteiro estoura em vez de arredondar). Nunca float; na API é string decimal (`Money`).
- **Sem exclusão de categoria/produto:** só `status` (`ACTIVE`/`INACTIVE`). Grupos e opções **são apagados e recriados** em bloco (`PUT .../option-groups`), por isso têm `DELETE` e não `UPDATE` em runtime. Pedidos futuros guardam cópia de nome/preço e não podem depender dessas linhas.
- **Regras que dependem de outras linhas ficam na aplicação** (`apps/api/src/products`): `max_choices <=` nº de opções do grupo; combo não aninha combo (produto vinculado sem grupos; produto vinculado por outro não recebe grupos); produto vinculado `ACTIVE` no momento do vínculo. A corrida entre vincular e dar grupos é serializada com `SELECT ... FOR UPDATE` das linhas de `products` envolvidas, em ordem de `id` (`product-lock.ts`).
- **Ajuste por filial:** ausência de linha = disponível com o preço base. Linha só é criada por upsert e removida para "voltar ao padrão".

## Pedidos do PDV (M5)
Balcão com senha: rascunho (`EDITING`) → confirmado com número do dia → preparo → pronto → entregue; cancelamento conforme o contrato. Migration `20261109000000_create_orders`. Tabelas de tenant no padrão M1/M4 (`tenant_id uuid NOT NULL`, FK para `tenants`, UUIDv7, `timestamptz(3)`, trigger `<tabela>_tenant_id_immutable`), FKs compostas `RESTRICT` (sem CASCADE). Pagamento (M6) e fiscal (M9) não estão aqui.

| Tabela | Colunas principais | FKs compostas | Uniques / índices |
|---|---|---|---|
| `orders` | `branch_id`, `status order_status`, `number` (nulo em EDITING), `business_date date` (nulo em EDITING), `total numeric(12,2)`, `created_by`, `confirmed_at`/`preparing_at`/`ready_at`/`delivered_at`/`cancelled_at`, `cancelled_by` (nulo), `cancel_reason` (nulo) | `(tenant_id, branch_id)` → `branches`; `(tenant_id, created_by)` e `(tenant_id, cancelled_by)` (`MATCH SIMPLE`) → `users` | `(tenant_id, branch_id, business_date, number)` (número único por filial e dia; NULLs não colidem; também atende o filtro por dia); `(tenant_id, id)`; `(tenant_id, branch_id, created_at DESC)` (listagem; cobre a FK da filial); `(tenant_id, branch_id, status)`; `(tenant_id, created_by)`; `(tenant_id, cancelled_by)` |
| `order_items` | `order_id`, `product_id`, `product_name`, `product_code`, `quantity`, `unit_price`, `line_total`, `note`, `sort_order` | `(tenant_id, order_id)` → `orders`; `(tenant_id, product_id)` → `products` | `(tenant_id, order_id, sort_order)`; `(tenant_id, id)`; `(tenant_id, product_id)` |
| `order_item_options` | `order_item_id`, `option_id`, `group_name`, `name`, `price_delta`, `linked_product_id`, `sort_order` | `(tenant_id, order_item_id)` → `order_items` | `(tenant_id, order_item_id, sort_order)`; `(tenant_id, order_item_id, option_id)` (opção uma vez por item) |
| `branch_order_counters` | `branch_id`, `business_date`, `last_number` | `(tenant_id, branch_id)` → `branches` | `(tenant_id, branch_id, business_date)` |

- **CHECKs:** `quantity` 1..99; dinheiro ≥ 0; `line_total = unit_price * quantity`; `number >= 1`; `number`, `business_date` e `confirmed_at` nulos juntos; timestamps coerentes com o status (`orders_status_check`, com `ELSE false`); `cancelled_by` só e sempre em CANCELLED, `cancel_reason` só em CANCELLED e obrigatório se o pedido já tinha sido confirmado, não vazio e ≤ 200; nomes não vazios; `note` nula ou não vazia e ≤ 140; `product_code` no formato de `products.code`; `last_number >= 1`.
- **Referências históricas:** itens e opções são CÓPIAS do cardápio. `order_items.product_id` tem FK (produtos nunca são apagados). `order_item_options.option_id` **não tem FK** (opções são apagadas na substituição de grupos do M4) e `linked_product_id` também não (é só cópia do vínculo de combo no momento do pedido).
- **Numeração:** número por filial e **dia de operação no fuso da filial** (`branches.timezone`), atribuído na confirmação por `INSERT ... ON CONFLICT (tenant_id, branch_id, business_date) DO UPDATE SET last_number = last_number + 1 RETURNING last_number`, dentro da transação da confirmação: a linha do contador fica travada até o commit (confirmações paralelas recebem números consecutivos; erro desfaz o incremento). Rascunho descartado não consome número. O id do contador é UUIDv7 gerado na aplicação (`uuid-v7.ts`; PostgreSQL 17 não tem `uuidv7()`).
- **Imutabilidade de venda no banco** (além da aplicação; vale para qualquer identidade com privilégio de escrita, inclusive o dono):
  - `forbid_order_line_change_unless_editing()` + triggers `order_items_editing_only` e `order_item_options_editing_only` (`BEFORE INSERT OR UPDATE OR DELETE`, por linha): itens/opções só mudam com o pedido `EDITING`; o status é lido com `FOR SHARE` (espera uma confirmação em andamento).
  - `forbid_order_mutation_after_confirmation()` + trigger `orders_immutable_after_confirmation` (`BEFORE UPDATE OR DELETE`): `DELETE` sempre rejeitado (rascunho descartado vira CANCELLED); filial, autor e criação nunca mudam; transição só pelas setas do contrato; depois da confirmação, total, número, dia e `confirmed_at` congelados e timestamp de estado já gravado não muda; sem troca de status só `updated_at` (e, em EDITING, o total) muda. `tenant_id` continua com o trigger genérico.
  - Privilégios: `erp_app` sem `DELETE` em `orders` e sem `UPDATE` em itens/opções.
  - Inventário fail-closed: `SALE_IMMUTABILITY_TRIGGERS`/`saleImmutabilityViolations` em `table-audit.ts` (nome, tabela, `BEFORE`, por linha, eventos, função, habilitado; função usada só por esses triggers), com sondas.

## Caixa e pagamentos (M6)
Um caixa por operador e filial; o pedido é pago antes de confirmar (pagamentos no caixa aberto de quem confirma); cancelar pedido pago gera estorno total. PIX/cartão são registro manual. Migrations `20261110000000_create_cash_and_payments` e `20261110010000_adjust_order_immutability`. Tabelas de tenant (UUIDv7, FKs compostas `RESTRICT`, trigger `<tabela>_tenant_id_immutable`). Fiscal fica no M9.

| Tabela | Colunas principais | FKs compostas | Uniques / índices |
|---|---|---|---|
| `cash_sessions` | `branch_id`, `status cash_session_status` (`OPEN`/`CLOSED`), `opened_by`, `opened_at`, `opening_amount`, `closed_by`, `closed_at`, `expected_cash`, `counted_cash`, `difference` (pode ser negativa), `justification` | `(tenant_id, branch_id)` → `branches`; `(tenant_id, opened_by)` e `(tenant_id, closed_by)` (`MATCH SIMPLE`) → `users` | `(tenant_id, branch_id, id)` (alvo das FKs com filial); **parcial** `cash_sessions_open_per_operator_key (tenant_id, branch_id, opened_by) WHERE status = 'OPEN'`; `(tenant_id, branch_id, opened_at DESC)`; `(tenant_id, opened_by)`; `(tenant_id, closed_by)` |
| `cash_movements` | `branch_id`, `cash_session_id`, `type cash_movement_type` (`SUPPLY`/`WITHDRAWAL`), `amount`, `reason`, `created_by` | `(tenant_id, branch_id, cash_session_id)` → `cash_sessions(tenant_id, branch_id, id)`; `(tenant_id, created_by)` → `users` | `(tenant_id, branch_id, cash_session_id)`; `(tenant_id, created_by)` |
| `payments` | `branch_id`, `order_id`, `cash_session_id`, `method payment_method`, `amount`, `received_amount`, `change`, `reference` | `(tenant_id, branch_id, order_id)` → `orders(tenant_id, branch_id, id)`; `(tenant_id, branch_id, cash_session_id)` → `cash_sessions` | `(tenant_id, branch_id, order_id)` (busca por pedido; cobre a FK); `(tenant_id, branch_id, cash_session_id)`; `(tenant_id, branch_id, id, order_id, method, amount)` (alvo da FK do estorno) |
| `refunds` | `branch_id`, `payment_id`, `order_id`, `method`, `amount`, `cash_session_id` (nulo fora de CASH), `created_by` | `(tenant_id, branch_id, payment_id, order_id, method, amount)` → `payments`; `(tenant_id, branch_id, cash_session_id)` (`MATCH SIMPLE`) → `cash_sessions`; `(tenant_id, created_by)` → `users` | `(tenant_id, branch_id, payment_id, order_id, method, amount)` (um estorno por pagamento; cobre a FK); `(tenant_id, branch_id, cash_session_id)`; `(tenant_id, created_by)` |

- **Mesma filial garantida no banco:** pagamento, estorno e movimento carregam `branch_id` e apontam para o caixa por `(tenant_id, branch_id, cash_session_id)` (e o pagamento para o pedido por `(tenant_id, branch_id, order_id)`): dinheiro nunca cai num caixa de outra filial. `orders` ganhou `UNIQUE (tenant_id, branch_id, id)` para isso.
- **Estorno = pagamento inteiro, no banco:** a FK do estorno para `payments(tenant_id, branch_id, id, order_id, method, amount)` obriga o estorno a repetir pedido, método e VALOR do pagamento; a unique desses seis campos equivale a "um estorno por pagamento" (o resto é fixado pela FK).
- **CHECKs:** `amount > 0` (pagamento, estorno, movimento); CASH ⇔ `received_amount >= amount` e `change = received_amount - amount`; demais métodos sem `received_amount` e `change = 0`; estorno CASH ⇔ `cash_session_id` preenchido; caixa `CLOSED` ⇔ todos os campos de fechamento; `difference = counted_cash - expected_cash`; justificativa obrigatória quando `difference <> 0` (3..500); `reason` 3..200; `reference` ≤ 60; valores ≥ 0.
- **Sem `updated_at`** em pagamentos, estornos e movimentos (append-only, como `audit_logs`).
- **Imutabilidade financeira (triggers; vale também para o dono):**
  - `forbid_financial_record_mutation()`: `payments_append_only`, `refunds_append_only`, `cash_movements_append_only` (`BEFORE UPDATE OR DELETE`, por linha) e `*_no_truncate` (`BEFORE TRUNCATE`, por statement) nessas três e em `cash_sessions`.
  - `check_financial_record_insert()` (`*_insert_guard`, `BEFORE INSERT`): caixa precisa estar OPEN (lido `FOR SHARE`: espera um fechamento em andamento); pagamento só com o pedido EDITING (durante a confirmação); estorno só com o pedido confirmado e ainda não cancelado.
  - `forbid_cash_session_mutation()` (`cash_sessions_close_once`, `BEFORE UPDATE OR DELETE`): `DELETE` rejeitado; depois de CLOSED nada muda; enquanto OPEN, filial, operador, abertura e fundo não mudam.
  - O trigger genérico de `tenant_id` existe também nas tabelas append-only (regra geral), mas o append-only dispara antes (ordem alfabética).
  - Inventário fail-closed: `SALE_IMMUTABILITY_TRIGGERS` (agora com nível linha/statement e `TRUNCATE`) em `table-audit.ts`, com sondas.
- **Ajuste do M5 (`20261110010000_adjust_order_immutability`, sem editar a migration do M5):** `forbid_order_mutation_after_confirmation()` aceita `DELIVERED > CANCELLED`; em toda transição só mudam as colunas do estado de destino (cancelamento grava só `cancelled_at`/`cancelled_by`/`cancel_reason`); `orders_status_check` mantém `delivered_at` no pedido cancelado após a entrega; `forbid_sales_truncate()` + `orders_no_truncate`, `order_items_no_truncate`, `order_item_options_no_truncate`.
- **Contas** (aplicação, centavos `bigint`): esperado em dinheiro = abertura + suprimentos − sangrias + Σ `amount` CASH (já líquido de troco) − estornos CASH lançados no caixa. O esperado gravado no fechamento é o conferido.
- **Serialização:** confirmação, estorno em dinheiro, sangria, suprimento e fechamento travam a linha do caixa `FOR UPDATE` (`cash-lock.ts`): o fechamento inclui tudo o que foi commitado antes e nada entra depois.

## Cozinha: setores e comandas (M7)
Setores de preparo do tenant, ligados/desligados por filial; comandas por setor criadas na confirmação do pedido; impressão pelo navegador. Migration `20261110020000_create_kitchen`. Tabelas de tenant (UUIDv7, FKs compostas `RESTRICT`, trigger `<tabela>_tenant_id_immutable`).

| Tabela | Colunas principais | FKs compostas | Uniques / índices |
|---|---|---|---|
| `kitchen_sectors` | `name`, `code`, `is_default`, `status kitchen_sector_status` (`ACTIVE`/`INACTIVE`), `sort_order` | — | `(tenant_id, code)`; `(tenant_id, id)` (alvo das FKs); **parcial** `kitchen_sectors_one_default_per_tenant_key (tenant_id) WHERE is_default` |
| `branch_kitchen_sectors` | `branch_id`, `sector_id`, `enabled` (sem linha = ligado) | `(tenant_id, branch_id)` → `branches`; `(tenant_id, sector_id)` → `kitchen_sectors` | `(tenant_id, branch_id, sector_id)`; `(tenant_id, sector_id)` |
| `products` (coluna nova) | `kitchen_sector_id` (nulo = setor padrão) | `(tenant_id, kitchen_sector_id)` (`MATCH SIMPLE`) → `kitchen_sectors` | `(tenant_id, kitchen_sector_id)` |
| `kitchen_tickets` | `branch_id`, `order_id`, `sector_id`, `sector_name`/`sector_code` (cópias), `status kitchen_ticket_status` (`WAITING`/`PREPARING`/`READY`/`CANCELLED`), `started_at`, `ready_at`, `cancelled_at`, `print_count`, `last_printed_at` | `(tenant_id, branch_id, order_id)` → `orders(tenant_id, branch_id, id)` (mesma filial do pedido); `(tenant_id, sector_id)` → `kitchen_sectors` | `(tenant_id, order_id, sector_id)` (uma comanda por setor por pedido); `(tenant_id, order_id, id)` (alvo da FK dos itens); `(tenant_id, branch_id, order_id)`; `(tenant_id, branch_id, created_at)` (fila); `(tenant_id, sector_id)` |
| `kitchen_ticket_items` | `order_id`, `ticket_id`, `order_item_id` (sem `updated_at`: append-only) | `(tenant_id, order_id, ticket_id)` → `kitchen_tickets(tenant_id, order_id, id)`; `(tenant_id, order_id, order_item_id)` → `order_items(tenant_id, order_id, id)` | `(tenant_id, order_id, order_item_id)` (cada item do pedido numa só comanda); `(tenant_id, order_id, ticket_id)` |

- **Mesmo pedido garantido no banco:** as duas FKs do item da comanda carregam `order_id`, então comanda e item da venda são do MESMO pedido e tenant. `order_items` ganhou `UNIQUE (tenant_id, order_id, id)` para isso.
- **CHECKs:** setor com `name` não vazio e ≤ 60, `code` no formato de `products.code`, `sort_order` 0..9999, e **padrão sempre ACTIVE** (`kitchen_sectors_default_active_check`); comanda com timestamps coerentes com o status (`kitchen_tickets_status_check`, `ELSE false`; READY sempre com `started_at`), `print_count >= 0` e `last_printed_at` preenchido ⇔ `print_count > 0`, cópias do setor não vazias e no formato do código.
- **Imutabilidade (triggers; vale também para o dono):**
  - `guard_kitchen_ticket()` (`kitchen_tickets_guard`, `BEFORE INSERT OR UPDATE OR DELETE`): nasce WAITING, sem timestamps e sem impressão, com o pedido CONFIRMED (lido `FOR SHARE`); `DELETE` rejeitado; identidade, pedido, filial, setor, cópias e criação nunca mudam; contagem de vias só cresce; sem troca de status só a impressão muda; transições só WAITING>PREPARING, WAITING>READY, PREPARING>READY e {WAITING, PREPARING, READY}>CANCELLED, sem imprimir junto; timestamp de estado já gravado nunca muda.
  - `guard_kitchen_ticket_item()` (`kitchen_ticket_items_guard`, `BEFORE INSERT OR UPDATE OR DELETE`): `UPDATE`/`DELETE` rejeitados; `INSERT` só com a comanda WAITING e nunca impressa.
  - `kitchen_tickets_no_truncate` e `kitchen_ticket_items_no_truncate` (`forbid_sales_truncate()`).
  - Os triggers de pedido do M5/M6 não mudaram: o status derivado anda pelas setas já aceitas (CONFIRMED>PREPARING>READY, uma por vez, cada uma gravando o próprio timestamp).
  - Inventário fail-closed: `SALE_IMMUTABILITY_TRIGGERS` em `table-audit.ts`.
- **Travas (ordem global, `kitchen-lock.ts`):** pedido → filial/empresa → caixa → contador (M5/M6) → setores do tenant (por `id`) → ajustes de setor da filial → comandas do pedido (por `id`). A confirmação lê setores e ajustes `FOR SHARE`; desativar setor e ligar/desligar setor na filial travam a linha do setor `FOR UPDATE`; trocar o padrão trava todos os setores do tenant `FOR UPDATE`. start/ready/cancelamento travam o pedido antes das comandas. A via de impressão é um `UPDATE ... RETURNING` na linha da comanda.
- **Backfill da migration:** setor padrão "Cozinha" (`COZINHA`, ACTIVE, `sort_order` 0) para todo tenant existente; permissão `order.prepare` inserida no catálogo (`ON CONFLICT (code) DO NOTHING`) e vinculada às roles **padrão** (`is_system`) `OWNER`, `MANAGER`, `ATTENDANT` e `KITCHEN` de todos os tenants (`ON CONFLICT DO NOTHING`; role customizada não é tocada, mesmo com código padrão). IDs UUIDv7 gerados em SQL. Pedidos já confirmados **não** ganham comandas (seguem o M5). Tenants novos ganham o setor em `TenantProvisioningService.provisionDefaultKitchenSector()` e o vínculo pela matriz.
- **Privilégios (`03-runtime-grants.sql`):** `kitchen_sectors`, `branch_kitchen_sectors` e `kitchen_tickets` com `SELECT, INSERT, UPDATE` (sem DELETE/TRUNCATE); `kitchen_ticket_items` com `SELECT, INSERT` (append-only também por privilégio).

## Identidades e privilégios do PostgreSQL (M1.14.2b)
Duas identidades, criadas fora das Prisma migrations por scripts de infraestrutura em [`infrastructure/postgres/`](../infrastructure/postgres/README.md) (sem senha no git):

| Identidade | Uso | Dona dos objetos | Atributos |
|---|---|---|---|
| admin/bootstrap (superusuário self-hosted ou master do RDS) | só provisionamento (`01`, `02`) | o database | — |
| `erp_migrator` | `prisma migrate deploy`, `db:seed`, `03-runtime-grants.sql` | **sim**: tabelas, enums, funções (triggers pertencem às tabelas) | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, sem memberships; `USAGE, CREATE` só em `public` |
| `erp_app` | API NestJS e workers | **nunca** | idem; sem memberships (não é membro de `erp_migrator`, não faz `SET ROLE`); só `USAGE` em `public` |

**Ordem:** (1) admin: `01-bootstrap-roles.sql` (cluster); (2) credenciais de login provisionadas fora do git; (3) admin, no banco do ERP: `02-bootstrap-database.sql`; (4) `erp_migrator`: `prisma migrate deploy` (e seed); (5) `erp_migrator`: `03-runtime-grants.sql`, a cada deploy; (6) a aplicação conecta como `erp_app`. A `DATABASE_URL` da aplicação/workers é sempre `erp_app`; a de migration/seed é `erp_migrator`; a identidade admin nunca é usada por eles.

**Matriz runtime de `erp_app`** (`03-runtime-grants.sql`, espelhada em `RUNTIME_TABLE_PRIVILEGES`; sem `GRANT ALL`):

| Tabela | `erp_app` | Observação |
|---|---|---|
| `tenants`, `companies`, `branches`, `users`, `roles`, `devices`, `sessions` | `SELECT`, `INSERT`, `UPDATE` | entidades mutáveis; sem `DELETE` (desativação por status) e sem `TRUNCATE` |
| `user_branch_access`, `role_permissions`, `user_roles` | `SELECT`, `INSERT`, `DELETE` | vínculos: delete + create; sem `UPDATE` e sem `TRUNCATE` |
| `permissions` | `SELECT` | catálogo global; escrita só pelo deploy (seed como `erp_migrator`) |
| `audit_logs` | `SELECT`, `INSERT` | append-only também por privilégio; sem `UPDATE`/`DELETE`/`TRUNCATE` |
| `product_categories`, `products` (M4) | `SELECT`, `INSERT`, `UPDATE` | cadastro mestre; sem `DELETE` (só status) e sem `TRUNCATE` |
| `product_option_groups`, `product_options` (M4) | `SELECT`, `INSERT`, `DELETE` | substituídos em bloco (delete + insert); sem `UPDATE` e sem `TRUNCATE` |
| `branch_product_settings` (M4) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | upsert do ajuste e `DELETE` para voltar ao padrão; sem `TRUNCATE` |
| `orders` (M5) | `SELECT`, `INSERT`, `UPDATE` | vendas nunca são apagadas (sem `DELETE`); congelado após a confirmação por trigger |
| `order_items`, `order_item_options` (M5) | `SELECT`, `INSERT`, `DELETE` | substituição em bloco só em EDITING (também por trigger); sem `UPDATE` |
| `branch_order_counters` (M5) | `SELECT`, `INSERT`, `UPDATE` | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`; sem `DELETE` |
| `payments`, `refunds`, `cash_movements` (M6) | `SELECT`, `INSERT` | registros financeiros append-only também por privilégio |
| `cash_sessions` (M6) | `SELECT`, `INSERT`, `UPDATE` | abrir e fechar uma vez (trigger congela depois); sem `DELETE` |
| `_prisma_migrations` | nenhum | ferramenta de migration |

Nenhuma tabela tem `REFERENCES` ou `TRIGGER` para `erp_app`; nenhuma tem grant por coluna; `PUBLIC` não tem privilégio em tabela alguma.

- **Schema `public`:** `PUBLIC` sem `CREATE` (explícito, também para servidores < 15); `erp_migrator` com `USAGE, CREATE`; `erp_app` só `USAGE`. Nenhuma das duas tem `CREATE` no database (não criam schemas). `CONNECT` explícito para as duas.
- **Funções:** `forbid_audit_log_mutation()` e `forbid_tenant_id_change()` sem `EXECUTE` para `PUBLIC` nem `erp_app` (só o dono). Triggers continuam disparando: o PostgreSQL não exige `EXECUTE` de quem dispara. `ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`: funções futuras nascem sem `EXECUTE` público; acesso de `erp_app` a uma função futura é concedido explicitamente.
- **Tabelas futuras:** sem default privileges de tabela. Uma tabela nova nasce sem nenhum privilégio runtime; o módulo declara sua política em `03-runtime-grants.sql` e em `RUNTIME_TABLE_PRIVILEGES`, senão a auditoria falha (fail-closed).
- **`03-runtime-grants.sql` é idempotente e fail-closed:** revoga tudo de `PUBLIC`/`erp_app` (tabelas e funções, inclusive grants por coluna) e reaplica a matriz, numa transação. O que não está no arquivo não existe.
- **Duas camadas em `audit_logs`:** privilégios (`erp_app` só `SELECT, INSERT`) e triggers append-only (valem para qualquer identidade com privilégio de escrita, inclusive o dono). Em `tenant_id`, o trigger de imutabilidade vale também para `erp_app`, que tem `UPDATE` nas entidades.
- **Testes:** o setup de integração executa os mesmos três scripts com roles únicas por execução (`erp_migrator_t<hex>`, `erp_app_t<hex>`) e senhas aleatórias em memória; migrations rodam como migrator; os testes de schema usam o migrator; `app-role.int.test.ts` conecta **de fato** como `erp_app`. Banco e roles são removidos ao final.
- **Auditoria fail-closed** (`runtime-privileges.int.test.ts` + `table-audit.ts`): `runtimePrivilegeViolations` compara o privilégio efetivo de `erp_app` (tabela, coluna, via `PUBLIC` ou membership) com `RUNTIME_TABLE_PRIVILEGES` para toda tabela de `public` (tabela sem política falha) e acusa privilégio em sequence; `ownershipViolations` exige `erp_migrator` como dono de toda relação, função e tipo de `public` e nenhum objeto do banco pertencente a `erp_app`; `privilegeModelViolations` verifica atributos e memberships das duas roles, `CREATE`/`USAGE` em `public`, `CREATE` no database, `EXECUTE` de funções (inclusive `PUBLIC` e ACL nula) e default privileges. Sondas (transação desfeita, como migrator ou admin) provam a detecção de cada desvio.
- **Fora do escopo/limites:** o dono (`erp_migrator`) e a identidade admin podem desabilitar triggers, alterar funções e executar DDL; a proteção é restringir essas credenciais ao pipeline/provisionamento. `PUBLIC` mantém o `TEMPORARY` padrão no database (objetos temporários de sessão, fora de `public`). Mecanismo de login em produção (senha via Secrets Manager ou IAM database authentication) **TBD**.

## Integridade organizacional (M1.4)
Regras: relações cross-tenant devem ser **bloqueadas no banco** sempre que possível, não só na aplicação; nenhuma FK organizacional usa `CASCADE`, `SET NULL` ou `SET DEFAULT` (apenas `RESTRICT`).

### `tenant_id` imutável (decisão fechada, imposta no banco — M1.14.1)
**`tenant_id` é imutável no banco para toda entidade editável pertencente a tenant.** Depois de criada, uma linha nunca muda de tenant: nem via Prisma, nem via SQL direto, nem quando todas as FKs são alteradas juntas de forma consistente. A regra não depende da aplicação.

**Mecanismo** (migration `20261002120000_make_tenant_id_immutable`):
- Função compartilhada `forbid_tenant_id_change()` (`plpgsql`, `RETURNS trigger`, sem argumentos). Não conhece nomes de tabela: usa `TG_TABLE_SCHEMA`/`TG_TABLE_NAME` na mensagem. Lança SQLSTATE **`23000`** (`integrity_constraint_violation`) com `COLUMN = 'tenant_id'`, `TABLE`, `SCHEMA` e `HINT`; mensagem `tenant_id is immutable: UPDATE on public.<tabela> cannot change tenant_id`. Rechecagem defensiva interna (`NEW.tenant_id IS DISTINCT FROM OLD.tenant_id`): continua correta mesmo se um trigger for criado sem o `WHEN`.
- Um trigger por tabela, `<tabela>_tenant_id_immutable`: `BEFORE UPDATE OF tenant_id ... FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id) EXECUTE FUNCTION forbid_tenant_id_change()`.
- Tabelas protegidas: `companies`, `branches`, `users`, `user_branch_access`, `roles`, `role_permissions`, `user_roles`, `devices`, `sessions`.
- **Fora do trigger genérico:** `audit_logs` (política própria: append-only, UPDATE/DELETE/TRUNCATE bloqueados); `tenants` (raiz, sem `tenant_id`); `permissions` (global, sem `tenant_id`); `_prisma_migrations`.

**O que continua permitido:** qualquer UPDATE que não mude o valor de `tenant_id` (`trade_name`, `name`, `revoked_at`...); `SET tenant_id = tenant_id` ou o mesmo UUID (o `WHEN` só dispara com mudança real); Prisma `update` repetindo o `tenantId` atual ou `connect` no mesmo tenant.

**O que é bloqueado** (testado): UPDATE direto, em massa, com `UPDATE ... FROM`, subconsulta, CTE `WITH ... UPDATE ... RETURNING`, junto de outras colunas, `INSERT ... ON CONFLICT DO UPDATE`, `MERGE`; no Prisma, `update`, `updateMany`, `upsert`, `connect` de outro tenant e `$transaction` (a transação inteira é desfeita). Bloqueia também `tenant_id` para tenant inexistente (o trigger dispara antes da FK).

**Ordem das barreiras:** o trigger BEFORE dispara antes das checagens de FK. Um UPDATE de `tenant_id` falha sempre pela imutabilidade (`23000`), nunca pela FK. As FKs compostas continuam existindo e sendo verificadas pelo catálogo, e seguem bloqueando trocas de `company_id`/`user_id`/`branch_id`/`role_id`/`device_id` para outro tenant (essas não mexem em `tenant_id`, então não passam pelo trigger).

| Alteração | Resultado | Mecanismo |
|---|---|---|
| `tenant_id` de qualquer linha de tabela editável de tenant (sozinho ou com FKs, consistente ou não, tenant existente ou não) | bloqueada | trigger `<tabela>_tenant_id_immutable` |
| `tenant_id` para o mesmo valor | aceita | `WHEN` não dispara |
| Branch: só `company_id` para Company de outro tenant | bloqueada | FK composta `branches_tenant_id_company_id_fkey` |
| UserBranchAccess: `user_id` ou `branch_id` de outro tenant | bloqueada | FKs compostas |
| RolePermission: `role_id` de outro tenant | bloqueada | FK composta |
| UserRole: `user_id`, `role_id` ou `branch_id` de outro tenant (ou filial sem acesso) | bloqueada | FKs compostas |
| Device: `branch_id` para filial de outro tenant | bloqueada | FK composta `devices_tenant_id_branch_id_fkey` |
| Session: `user_id`/`device_id` de outro tenant | bloqueada | FKs compostas de `sessions` |
| AuditLog: qualquer alteração, inclusive `tenant_id`; DELETE; TRUNCATE | bloqueada | triggers `audit_logs_append_only` e `audit_logs_no_truncate` |

**Novas tabelas de tenant** precisam do trigger `<tabela>_tenant_id_immutable` na própria migration de criação; a auditoria do catálogo falha sem ele (abaixo). Uma tabela de tenant só fica sem o trigger genérico se for declarada em `SPECIAL_TENANT_ID_POLICIES` com política verificável (hoje só `audit_logs`, append-only).

**Limites:** o trigger é `UPDATE OF tenant_id`, ou seja, só dispara quando `tenant_id` está no `SET` (ou no `UPDATE SET` de `ON CONFLICT`/`MERGE`). Um futuro trigger BEFORE que altere `NEW.tenant_id` sem que a coluna esteja no `SET` não seria pego; não existe nenhum hoje, e o inventário fail-closed de triggers exige revisão para qualquer trigger novo. A identidade runtime (`erp_app`) não consegue desabilitar, remover ou recriar triggers e funções; o dono (`erp_migrator`) e a identidade admin conseguem (M1.14.2b).

### Auditoria automatizada do catálogo
`org-integrity.int.test.ts` (com `test/integration/table-audit.ts`) classifica **toda** tabela de `public` em: raiz (`tenants`), ferramenta do Prisma (`_prisma_migrations`), **global explicitamente declarada** (`GLOBAL_TABLES`, hoje só `permissions`) ou tabela de tenant (todo o resto). É fail-closed: uma tabela nova sem `tenant_id` só passa se for adicionada à lista de globais, decisão explícita e revisada; tabelas globais não podem ter `tenant_id` nem FK para `tenants`. Testes-sonda criam tabelas inválidas numa transação desfeita e provam que a auditoria as reporta. Falha também se: alguma tabela de tenant não tiver `tenant_id uuid NOT NULL`; faltar a FK direta `tenant_id → tenants(id)`; alguma FK usar `CASCADE`/`SET NULL`/`SET DEFAULT`; uma FK violar a regra por classificação do alvo (abaixo); o conjunto de FKs mudar; ou existir coluna textual com nome de credencial (`password`, `pwd`, `senha`, `secret`, `pin`, `credential`, `token`, `api_key`, `private_key`) fora da allowlist explícita de hashes `HASHED_CREDENTIAL_COLUMNS` (`users.password_hash`, `sessions.refresh_token_hash`). A verificação é por nome de coluna (inclusive `json`/`jsonb`); o conteúdo de `audit_logs.metadata` não é inspecionado. A allowlist é por `tabela.coluna`: `refresh_token_hash` em outra tabela também é reportado; flags como `must_change_password` não contam (só colunas textuais). Tabelas novas entram na auditoria automaticamente.

**Imutabilidade de `tenant_id` na auditoria** (`tenantIdImmutabilityViolations`, M1.14.1): a lista de tabelas protegidas **é derivada da classificação** (toda tabela de tenant), não de uma lista manual. Para cada uma, exige exatamente um trigger que chame `forbid_tenant_id_change()`, chamado `<tabela>_tenant_id_immutable`, `BEFORE`, `FOR EACH ROW`, só `UPDATE`, `UPDATE OF tenant_id`, habilitado (`tgenabled = 'O'`) e com definição idêntica à aprovada (`pg_get_triggerdef`, inclusive o `WHEN`). Exceção **explícita e verificada**: `SPECIAL_TENANT_ID_POLICIES` (hoje só `audit_logs` → append-only). A política declara a função e os triggers exigidos: `audit_logs_append_only` (`BEFORE UPDATE OR DELETE`, por linha) e `audit_logs_no_truncate` (`BEFORE TRUNCATE`, por statement), ambos habilitados, sem `INSERT` e chamando `forbid_audit_log_mutation()`. A auditoria exige que a política declarada bloqueie todos os eventos de `APPEND_ONLY_BLOCKED_EVENTS` (`UPDATE`, `DELETE`, `TRUNCATE`) — tabela parcialmente protegida é violação —, que cada trigger exigido exista exatamente como declarado e que **nenhum outro trigger** exista na tabela (inclusive o genérico de `tenant_id`). Também falha se `forbid_tenant_id_change()` for usada em tabela não-tenant ou `forbid_audit_log_mutation()` fora de `audit_logs`. Sondas (transação desfeita) provam a detecção de: tabela sem trigger, trigger `AFTER`, por statement, sem `OF tenant_id`, sem `WHEN`, também em `DELETE`, desabilitado, com outro nome, política append-only desabilitada/ausente, guarda de TRUNCATE ausente/desabilitada/`AFTER`/com outra função/também em `INSERT`, trigger extra na tabela append-only, política declarada sem `TRUNCATE` e uso das funções na tabela errada.

**FKs são julgadas pela classificação das tabelas, não pelas colunas atuais** (`foreignKeyViolations`):
- tenant → `tenants`: exatamente `(tenant_id) → tenants(id)`;
- tenant → tenant: `tenant_id` nos dois lados (FK composta);
- tenant → **global declarada**: FK simples permitida (ex.: `role_permissions.permission_id → permissions.id`);
- global/raiz/ferramenta → tenant ou raiz: proibido; qualquer FK → `_prisma_migrations`: proibido.

Não há exceção genérica: uma FK simples só é aceita se o alvo estiver em `GLOBAL_TABLES`. Sondas provam que FK simples tenant → tenant é rejeitada, tenant → global declarada é aceita, a mesma FK para uma tabela não declarada é rejeitada e uma tabela global não pode apontar para dado de tenant. Toda FK composta precisa ter `tenant_id` `NOT NULL` (com `MATCH SIMPLE`, um `tenant_id` nulo desligaria a verificação); as únicas FKs compostas com coluna anulável são os vínculos opcionais declarados explicitamente no teste: `branch_id` de `user_roles` e de `devices`, `device_id` de `sessions`, e `user_id`, `branch_id` e `device_id` de `audit_logs`; no M4, `products.category_id` e `product_options.linked_product_id`; no M5, `orders.cancelled_by`; no M6, `cash_sessions.closed_by` e `refunds.cash_session_id`.

### Validações que ficam fora do banco
- **CNPJ completo** (dígitos verificadores; raiz do CNPJ da Branch x Company): responsabilidade futura de `packages/validation`. O banco garante só o formato (14 dígitos) e a unicidade por tenant.
- **Timezone IANA** (Company e Branch): validado na camada de aplicação; o banco guarda texto obrigatório, sem lista própria.
- **Branch.code** e **Product.code**: normalização trim + uppercase na aplicação (o banco valida o formato de `products.code`).
- **Catálogo (M4)**: `max_choices` ≤ nº de opções, combo não aninha combo e produto vinculado `ACTIVE` (seção "Catálogo de produtos (M4)").

## Índices e constraints físicos (M1.14.3)
O **catálogo do PostgreSQL é a fonte de verdade** do schema físico; o schema Prisma não representa tudo. Inventário do M1 (50 índices antes do M1.14.3, 49 depois, contando `_prisma_migrations_pkey`; todos B-tree; 24 FKs; 21 CHECKs; 2 índices parciais; 2 funções; 11 triggers; nenhum event trigger):

- **Índice removido:** `companies_tenant_id_idx (tenant_id)` — nenhuma FK ou constraint o usava (`pg_depend`/`conindid` vazios), e `companies_tenant_id_status_idx`, `companies_tenant_id_cnpj_key` e `companies_tenant_id_id_key` têm `tenant_id` como primeira coluna. Era o único índice comum cujo conjunto de colunas é prefixo de outro índice da mesma tabela. Nenhum outro índice redundante foi encontrado.
- **Uniques auxiliares que continuam:** `UNIQUE (tenant_id, id)` em `companies`, `branches`, `users`, `roles` e `devices` parecem redundantes com a PK, mas são o alvo das FKs compostas multi-tenant (Branch→Company; UserBranchAccess/AuditLog/Device→Branch; UserBranchAccess/UserRole/Session/AuditLog→User; RolePermission/UserRole→Role; Session/AuditLog→Device). `user_branch_access (tenant_id, user_id, branch_id)` é também alvo da FK de UserRole. A auditoria exige que toda `UNIQUE (tenant_id, id)` seja usada por ao menos uma FK.
- **Cobertura de FKs:** todas as 24 FKs têm, na tabela filha, um índice B-tree comum (não parcial, sem expressão) cujo prefixo esquerdo são as colunas da FK na mesma ordem; assim o `RESTRICT` ao apagar/alterar o pai não varre a filha. Nenhuma exceção (`FK_COVERAGE_EXCEPTIONS` vazio).
- **Índices globais aprovados** (não começam por `tenant_id`): `permissions_code_key`, `permissions_module_idx` (catálogo global), `role_permissions_permission_id_idx` (FK para o catálogo global) e `sessions_refresh_token_hash_key` (unicidade global). Todo o resto começa por `tenant_id` (exceto PKs).
- **Depois do M6:** 60 FKs (todas `RESTRICT`, todas cobertas), 68 CHECKs, 3 índices parciais, 41 triggers, 8 funções. Alvos de FK com filial: `orders (tenant_id, branch_id, id)`, `cash_sessions (tenant_id, branch_id, id)`, `payments (tenant_id, branch_id, id, order_id, method, amount)`.
- **Depois do M5:** 46 FKs (todas `RESTRICT`, todas cobertas), 57 CHECKs, 23 triggers, 4 funções; novos alvos `UNIQUE (tenant_id, id)`: `orders` e `order_items`. Sem índice isolado por `business_date`: a unique do número já começa por `(tenant_id, branch_id, business_date)` (a auditoria de redundância o rejeitaria).
- **Depois do M4:** 35 FKs (todas `RESTRICT`, todas cobertas), 39 CHECKs, 16 triggers, 2 funções. Novos alvos `UNIQUE (tenant_id, id)`: `product_categories` (Product→Category) e `products` (Group/Option combo/BranchProductSetting→Product); `product_option_groups (tenant_id, product_id, id)` é o alvo da FK das opções.
- **AuditLog:** os cinco índices começam por `tenant_id` e cobrem as FKs para users/branches/devices; mantidos. Sem GIN em `metadata` nem índice em `action`.
- **Regra para índices futuros:** não adicionar índice sem necessidade estrutural (cobrir FK, impor unicidade, regra de negócio) ou workload real medido em ambiente representativo. `pg_stat_user_indexes` e `EXPLAIN` com fixtures de teste não justificam criar nem remover índice. Toda FK nova precisa de índice cobrindo suas colunas na tabela filha (a auditoria falha sem ele) e tabela de tenant mantém `tenant_id` como primeira coluna.

**Pontos cegos do Prisma** (não representados no `schema.prisma` e/ou ignorados por `prisma migrate diff`; protegidos só pelos testes de catálogo):

| Garantia | Onde é protegida |
|---|---|
| CHECKs manuais (21 no M1; 39 após o M4; 57 após o M5; 68 após o M6) | `MANUAL_CHECK_CONSTRAINTS` (schema-hardening) + listas exatas por tabela (migration) |
| Índices parciais `user_roles_tenant_scope_key` / `user_roles_branch_scope_key` / `cash_sessions_open_per_operator_key` (M6) | `MANUAL_PARTIAL_INDEXES` (colunas, ordem, unicidade, B-tree, predicado) + migration |
| Funções `forbid_audit_log_mutation()`, `forbid_tenant_id_change()`, `forbid_order_line_change_unless_editing()`, `forbid_order_mutation_after_confirmation()` e as funções financeiras do M6 (`forbid_financial_record_mutation`, `check_financial_record_insert`, `forbid_cash_session_mutation`, `forbid_sales_truncate`); triggers (11 no M1; 16 após o M4; 23 após o M5; 41 após o M6) | inventário de funções/triggers (migration), auditorias de imutabilidade, append-only e venda (`saleImmutabilityViolations`) |
| Event triggers | nenhum existe; o inventário de funções/triggers falharia com função nova |
| Privilégios/ACL de tabelas, funções e schema; default privileges | `runtimePrivilegeViolations`, `privilegeModelViolations` (runtime-privileges) |
| Ownership | `ownershipViolations` (runtime-privileges) |

Índices comuns, uniques e FKs **são** representados no Prisma e o teste de drift os acusa; ainda assim o inventário de índices e a auditoria de cobertura/redundância verificam o catálogo. Comprovado nas checagens negativas do M1.14.3: alterar o predicado de um índice parcial ou remover um CHECK passa pelo teste de drift e só os testes de catálogo falham.

## CHECK constraints, índices parciais, funções e triggers
O schema Prisma não representa CHECKs nem índices únicos parciais (`user_roles`): eles são escritos à mão na migration. Consequências:
- `prisma migrate diff`/`migrate dev` **não** os geram nem os removem, e o teste de drift **não** os detecta; por isso o teste de migration verifica cada CHECK explicitamente.
- O mesmo vale para **funções e triggers** (hoje `forbid_audit_log_mutation()` + `audit_logs_append_only` + `audit_logs_no_truncate` e `forbid_tenant_id_change()` + os 14 `<tabela>_tenant_id_immutable`, 5 deles do M4): confirmado nas checagens negativas do M1.13.1, M1.14.1 e M1.14.2a que o teste de drift passa mesmo sem o trigger. Por isso há testes de catálogo obrigatórios: inventário fail-closed explícito de funções de `public` e de triggers não internos (`migration.int.test.ts`), a auditoria de imutabilidade de `tenant_id` (`org-integrity.int.test.ts`) e, em `audit-log.int.test.ts`, existência, tabela, eventos, `BEFORE`, nível (linha para UPDATE/DELETE, statement para TRUNCATE), habilitação (`tgenabled = 'O'`), definição exata e ausência de outros triggers em `audit_logs`. Trigger ou função nova exige atualizar o inventário.
- Ao recriar ou alterar a tabela em migration futura, os CHECKs precisam ser mantidos manualmente.
- O schema registra em comentário quais CHECKs existem em cada model.

## Versão do Prisma
- O projeto iniciou com **Prisma ORM 7** (CLI fixado em `~7.10.0` em `apps/api`).
- Upgrades de major (ex.: Prisma 8) são **tarefas explícitas e dedicadas**.
- Nunca atualizar a major do Prisma automaticamente como parte de outra feature.
- `@prisma/client` e `@prisma/adapter-pg` fixados em `~7.10.0`, mesma versão do CLI. No Prisma 7 o client exige driver adapter.
- Client gerado (`prisma-client`, ESM) em `apps/api/src/generated/prisma`, fora do git; `build`, `typecheck` e `test:integration` executam `prisma generate`.
- `PrismaClient` é criado **somente** por `createPrismaClient` (`apps/api/src/database/create-prisma-client.ts`), ver "Fuso da sessão". O ESLint (`npm run lint`) bloqueia `new PrismaClient(...)` e o import de valor de `PrismaClient` em qualquer outro arquivo (import apenas de tipo é permitido).

## Multi-tenancy
- PostgreSQL compartilhado; isolamento lógico por `tenant_id`.
- `tenant_id` obrigatório em toda tabela com dado pertencente ao cliente.
- Constraints devem reforçar o isolamento quando possível: unicidade composta (ex.: matrícula única por `(tenant_id, matricula)`), FKs que incluam `tenant_id`, índices iniciados por `tenant_id`.
- Esquema compatível com RLS; RLS será ativada em fase posterior ([security.md](security.md)).
- Proibido: database-per-tenant e schema-per-tenant.
- **Auth e autorização (M2):** usam só a matriz runtime existente de `erp_app` (SELECT/INSERT/UPDATE em `users`, `sessions`, `roles`; SELECT em `devices`, `tenants`, `permissions`, `user_roles`, `role_permissions`, `branches`; INSERT em `audit_logs` e `role_permissions`). Nenhum privilégio novo; a auditoria `RUNTIME_TABLE_PRIVILEGES` segue inalterada.
- **Acesso a dados (M2.1):** o banco não filtra leitura por tenant. Toda query de negócio em tabela tenant-scoped inclui `tenant_id` do `TenantContext` (`TenantScope`, [architecture.md](architecture.md)), mesmo quando filtra por `id` UUID. `tenants` (raiz) e `permissions` (global) nunca recebem filtro implícito. O padrão não exigiu migration nem grant novo: `erp_app` mantém a matriz exata acima.

## Convenções
| Tema | Decisão |
|---|---|
| IDs | UUIDv7 para IDs principais (offline, Edge, sync, idempotência). Gerado pelo Prisma Client via `@default(uuid(7))`, coluna `@db.Uuid` (tipo `uuid`). Sem default no banco: inserts fora do Prisma (SQL bruto, outras ferramentas) precisam informar o `id`. |
| Dinheiro | `numeric(12,2)` em reais, nunca float (decidido em 07/11/2026; M4). Na API: string decimal com 2 casas. |
| Tempo | `timestamptz(3)` (precisão de ms, igual ao `Date` do JS), armazenado em UTC. |
| Remoção | **Sem soft delete universal.** Estratégia por entidade: **TBD**. |
| Imutáveis | Vendas, pagamentos, fiscal e auditoria **nunca** são apagados fisicamente. `audit_logs` é append-only (UPDATE, DELETE e TRUNCATE bloqueados por trigger no PostgreSQL). |
| Idempotência | Operações vindas de PDV offline carregam idempotency key única (escopo por tenant). Desenho: **TBD**. |

## Fuso da sessão
O `@prisma/adapter-pg` 7.10 envia `DateTime` como hora UTC **sem offset** e, ao ler, descarta o offset retornado; ou seja, presume sessão em UTC. Se o banco/servidor tiver outro fuso padrão (ex.: `America/Sao_Paulo`), o Prisma continua lendo o que escreveu, mas o instante gravado fica deslocado (3h) para SQL bruto, workers e `now()`. Por isso `createPrismaClient` abre toda conexão com `-c TimeZone=UTC`. Os testes de integração criam o banco com fuso padrão `America/Sao_Paulo` para detectar regressões.

## Modelo conceitual
```mermaid
erDiagram
  TENANT ||--|{ COMPANY : possui
  COMPANY ||--|{ BRANCH : possui
  TENANT ||--|{ USER : possui
  USER }o--o{ BRANCH : acessa
```
Conceitual apenas; não é schema. Todas as entidades de cliente carregam `tenant_id`.

## Migrations
- Migrations aplicadas nunca são editadas.
- Migrations destrutivas exigem revisão explícita.
- Preferir mudanças retrocompatíveis (expand/contract) para permitir deploy gradual e rollback ([deployment.md](deployment.md)).
