# CLAUDE.md

ERP SaaS multi-tenant para pequenas e médias lojas/restaurantes de alimentação em shopping centers no Brasil. Veja `docs/` para detalhes e `AGENTS.md` para a visão de arquitetura.

## Git workflow

- Nunca desenvolver diretamente na `main`. A `main` deve permanecer estável.
- Cada tarefa usa uma branch curta: `feat/<nome>`, `fix/<nome>`, `refactor/<nome>` ou `chore/<nome>`.
- Commits seguem Conventional Commits.
- Toda alteração entra na `main` via Pull Request.
- Antes do PR: lint, typecheck e testes relacionados.

## Regras de engenharia

- Não realizar mudanças arquiteturais fora do escopo sem aprovação explícita.
- Alterações de arquitetura, banco, segurança ou regras de negócio devem atualizar a documentação em `docs/`.
- Nunca colocar secrets no código.
- Nunca editar migrations já aplicadas.
- Migrations destrutivas exigem revisão explícita.
- Preferir mudanças de banco retrocompatíveis durante deploys.
- Toda feature relevante deve possuir testes.
- Nenhuma regra fiscal deve ser inventada. Regras de negócio só entram se fornecidas.

## Multi-tenancy

- Todo dado de cliente é isolado por tenant.
- Nunca confiar em `tenant_id` vindo livremente do frontend; o tenant vem do contexto autenticado.
- Toda operação de negócio em entidade tenant-scoped obtém `tenant_id` do `TenantContext` e o inclui no escopo da query (`TenantScope`); nunca buscar/alterar só por `id`. `Tenant` e `Permission` são exceções por classificação (`docs/architecture.md`).
- Modelar para múltiplas filiais.

## Auth (M2)

- Rotas exigem autenticação por padrão (AuthGuard global); `@Public()` só em método e com justificativa explícita (marca de classe é ignorada).
- Operação em escopo de filial usa `@RequireBranchPermissions` (ou `branchScope` com filial resolvida do recurso) e exige `UserBranchAccess`, mesmo com role tenant-wide.
- Controllers declaram `@RequirePermissions`/`@RequireBranchPermissions` com códigos de permissão; nunca checar nome de role.
- Senha só via `PasswordHasher` (Argon2id); nunca logar ou auditar senha, token ou hash. Eventos de segurança só via `SecurityAuditWriter` (allowlist).
- Valores marcados `DECISION REQUIRED` em `AUTH_SECURITY_POLICY`, `auth-config.ts` e `default-roles.ts` não são alterados sem decisão de produto.

## Comandos

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
