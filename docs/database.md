# Banco de dados

## Estado atual
PostgreSQL via Prisma. Schema em `apps/api/prisma/schema.prisma` está **vazio** (apenas datasource). Nenhum modelo de negócio existe. A URL de conexão virá de variável de ambiente, nunca do código.

## Multi-tenancy (decisão aprovada)
- Banco PostgreSQL compartilhado.
- Toda tabela com dado de cliente terá coluna `tenant_id`.
- Isolamento obrigatório na aplicação (toda consulta filtrada pelo tenant do contexto autenticado).
- Esquema e índices devem ser compatíveis com Row-Level Security do PostgreSQL; RLS não será ativada agora.
- Proibido: database-per-tenant e schema-per-tenant.

## Diretrizes de migrations
- Migrations aplicadas nunca são editadas.
- Migrations destrutivas exigem revisão explícita.
- Preferir mudanças retrocompatíveis durante deploys.

## Modelo
_A definir._

## Versão do Prisma
- O projeto iniciou com **Prisma ORM 7** (CLI fixado em `~7.10.0` em `apps/api`).
- Upgrades de major (ex.: Prisma 8) devem ser **tarefas explícitas e dedicadas**.
- Nunca atualizar a major do Prisma automaticamente como parte de outra feature.
- `@prisma/client` ainda não está instalado; entra junto com os primeiros models.
