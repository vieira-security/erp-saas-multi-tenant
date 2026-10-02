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
- Modelar para múltiplas filiais.

## Comandos

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
