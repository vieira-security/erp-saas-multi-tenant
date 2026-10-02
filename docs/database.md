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
