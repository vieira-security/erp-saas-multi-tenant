# Segurança

## Diretrizes gerais
- Nenhum secret no código (AWS Secrets Manager em produção).
- Dados fiscais, pagamentos e auditoria são imutáveis fisicamente.

## Isolamento de tenant
1. **Contexto autenticado:** o tenant é derivado da autenticação (usuário/dispositivo), nunca de input livre do frontend. Vale também para clientes offline/Edge: o tenant vem da credencial do dispositivo/sessão.
2. **Aplicação:** repository/service exigem tenant context; acesso sem contexto deve falhar.
3. **Banco:** `tenant_id` obrigatório e constraints reforçando o isolamento quando possível. Relações cross-tenant devem ser **impossíveis no banco** sempre que viável (FK composta incluindo `tenant_id`, ver [database.md](database.md)); FKs organizacionais nunca usam cascade.
   - **`tenant_id` é imutável:** um registro nunca é movido para outro tenant. Hoje o banco bloqueia as trocas que gerariam vínculo cruzado, mas ainda aceita uma mudança consistente (Company sem filiais; Branch com `tenant_id` + `company_id` juntos). O mesmo vale para User sem acessos, para UserBranchAccess movido por inteiro (`tenant_id` + `user_id` + `branch_id`), para Role sem permissões, para RolePermission movido com `tenant_id` + `role_id` juntos, para UserRole movido por inteiro, para Device (de nível do tenant, ou com `tenant_id` + `branch_id` juntos) e para Session movida por inteiro. Proteção no banco prevista para o M1.14 (trigger genérico de `tenant_id`); `audit_logs` já está protegida por ser append-only (nenhum UPDATE é aceito). até lá, nenhuma API/serviço pode permitir alterar `tenant_id`.
4. **RLS (fase posterior):** segunda camada de proteção; **não ativa** hoje. Mecanismo de transmissão do tenant à sessão do banco e interação com pool de conexões/Prisma: **TBD**.
5. **Testes:** testes de isolamento multi-tenant obrigatórios ([testing-strategy.md](testing-strategy.md)).

## Fluxo de contexto (conceitual)
```mermaid
sequenceDiagram
  participant C as Cliente (Web/PDV)
  participant A as API (auth)
  participant S as Service/Repository
  participant D as PostgreSQL
  C->>A: credenciais / token
  A-->>C: sessão (tenant, usuário, filial, dispositivo)
  C->>A: requisição (sem tenant_id livre)
  A->>S: tenant context derivado do token
  S->>D: consulta filtrada por tenant_id
```

## Autenticação, autorização e dispositivos
Módulos `auth`, `roles`, `permissions`, `devices` (ver [architecture.md](architecture.md)). Mecanismo de autenticação, política de sessão, expiração offline e modelo de permissões: **TBD**.

**Devices** ([database.md](database.md)): pertencem ao tenant, com filial opcional (quando houver, do mesmo tenant, garantido por FK composta). `device_key` é identificador técnico, **não é segredo**. Autenticação de dispositivo, pairing, certificados e segredos **não estão implementados**; quando existirem, ficarão em módulo próprio e nunca em texto puro. `EDGE` é apenas um tipo estrutural. O status `REVOKED` ainda não bloqueia nada automaticamente.

**Sessions** ([database.md](database.md)): pertencem a User/Tenant, com Device opcional (do mesmo tenant quando presente). Persiste-se **apenas o hash** do refresh token atual (`refresh_token_hash`, globalmente único); refresh token puro e access token **nunca** são persistidos. O estado é derivado de `expires_at`/`revoked_at`. Geração, hash, rotação, comparação e proteção contra replay/reuso de tokens ficam para o M2, assim como revogação automática (ex.: ao desativar usuário) e limpeza. Retenção/LGPD de sessões históricas ainda será definida. A auditoria de credenciais aceita só os hashes da allowlist explícita (`users.password_hash`, `sessions.refresh_token_hash`).

**Autenticação ainda não está implementada.** Existe apenas o model persistente `User` ([database.md](database.md)):
- login previsto no PDV por matrícula (única por tenant) + senha; usuários são individuais;
- a senha **nunca** é persistida em texto puro: só `password_hash`, produzido pela futura camada Auth (algoritmo no M2, previsão Argon2id); não há coluna de senha temporária em texto;
- `must_change_password`, `failed_login_attempts`, `locked_until` e `last_login_at` existem, mas nenhuma lógica os altera ainda;
- usuário desativado (`DISABLED`) permanece no histórico; não há exclusão física no fluxo normal.

**Acesso a filiais (`UserBranchAccess`) é separado de papel/permissão.** O vínculo só diz quais filiais (0..N) o usuário pode acessar; o que ele pode fazer será definido por roles/permissions (inclusive por filial), ainda não modelados. O vínculo só existe dentro do mesmo tenant, garantido no banco por FKs compostas com `tenant_id`. Nenhuma verificação de acesso (guard/autorização) está implementada.

**Roles (RBAC) pertencem ao Tenant** ([database.md](database.md)). Códigos padrão previstos: `OWNER`, `MANAGER`, `ATTENDANT`, `KITCHEN`, criados futuramente no provisionamento do Tenant; roles customizadas são suportadas. Hoje uma Role **não concede nenhuma permissão**: RolePermission e a atribuição de roles a usuários (UserRole) ainda não existem.

**Permission é um catálogo global**, controlado pelo sistema (seed), sem `tenant_id`: define apenas capacidades técnicas (`branch.manage`, `order.cancel`...). O `code` é identificador estável usado pelo código. Clientes não criam nem editam permissões; o que varia por tenant é quais permissões cada Role tem, via `RolePermission` (por tenant). A Role é garantida no mesmo tenant por FK composta `(tenant_id, role_id)`; a FK para Permission é simples porque Permission é global. Permission vinculada não pode ser apagada (`RESTRICT`). A matriz de permissões das roles padrão ainda será decidida, e nenhuma permissão é efetivamente aplicada: não existe verificação de autorização.

**UserRole atribui roles a usuários, globais ou por filial.** `branch_id` `NULL` = role válida em todo o tenant; preenchido = só naquela filial e **exige UserBranchAccess**, garantido no banco por FK composta `(tenant_id, user_id, branch_id)` → `user_branch_access`. User, Role e acesso são sempre do mesmo tenant. Índices únicos parciais impedem atribuições duplicadas (inclusive a global, onde `NULL` não fura a unicidade). Global e específica podem coexistir. Alterações de atribuição devem ser feitas por remoção + criação. Nenhum guard ou serviço de autorização usa esses vínculos ainda. Toda tabela sem `tenant_id` precisa estar declarada explicitamente como global na auditoria estrutural.

## Auditoria
Módulo `audit`; registros não apagáveis fisicamente. Escopo dos eventos auditados: **TBD**.

**AuditLog** ([database.md](database.md)) é a estrutura persistente da trilha: por tenant, com usuário, filial e dispositivo opcionais (do mesmo tenant quando presentes, garantido por FKs compostas). Eventos sem usuário (workers, rotinas, sistema, só dispositivo) usam `user_id NULL`; não existe usuário fictício `SYSTEM`. `action` e `resource_type` são identificadores técnicos validados por CHECK de formato, sem enum; `resource_id` é referência lógica sem FK, para que o log sobreviva ao recurso. **Nada grava eventos ainda**: instrumentação de controllers/services/workers e o `AuditService` são etapas futuras.

- **Append-only imposto pelo PostgreSQL:** o trigger `audit_logs_append_only` (função `forbid_audit_log_mutation()`, específica desta tabela) rejeita fisicamente todo `UPDATE` e `DELETE`, vindos do Prisma, de SQL direto ou de qualquer ferramenta. Correção de um evento = novo evento. É distinto do futuro trigger genérico de `tenant_id` (M1.14). Limites: não cobre `TRUNCATE` nem um papel com privilégio para desabilitar triggers; o papel do banco usado pela aplicação não deve ser dono das tabelas nem superusuário (estratégia de papéis pendente, #7).
- **`metadata` (jsonb) nunca guarda credenciais nem segredos:** senha, `password_hash`, refresh/access token, `refresh_token_hash`, API key, segredo, chave privada, PIN, dados completos de cartão. Não há sanitizador automático nem verificação de conteúdo no banco; a auditoria de credenciais do catálogo checa só nomes de colunas. O futuro `AuditService` deve filtrar/mascarar `metadata` antes de gravar (allowlist de campos preferível a blocklist).
- `ip_address` e `metadata` podem conter dado pessoal: retenção e LGPD pendentes (#9).

## Automação externa
n8n e integrações só alteram dados críticos via API autenticada; nunca por acesso direto ao banco.

## Privacidade/LGPD
A imutabilidade física de vendas, pagamentos, fiscal e auditoria precisa ser conciliada com pedidos de eliminação de dados pessoais: **TBD — validação jurídica**.
