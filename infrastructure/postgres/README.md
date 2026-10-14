# PostgreSQL — identidades e privilégios

Bootstrapping de infraestrutura do banco do ERP. **Não faz parte das Prisma migrations**: roles são do cluster/ambiente, não evolução do schema. Nenhum arquivo daqui contém senha. Detalhes e matriz de privilégios em [docs/database.md](../../docs/database.md) e [docs/security.md](../../docs/security.md).

## Identidades

| Identidade | Uso | Dona dos objetos | Atributos |
|---|---|---|---|
| admin/bootstrap (superusuário self-hosted ou master do RDS) | só provisionamento (`01`, `02`) | database | — |
| `erp_migrator` | `prisma migrate deploy`, `db:seed`, `03` | sim (tabelas, enums, funções; triggers via tabela) | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, sem memberships |
| `erp_app` | API NestJS e workers (`DATABASE_URL` runtime) | nunca | idem; sem memberships, sem `CREATE` em `public` |

A identidade admin **nunca** é a `DATABASE_URL` da aplicação nem de workers. `erp_migrator` **nunca** é usada em runtime.

## Ordem

1. **Admin, uma vez por cluster:** `01-bootstrap-roles.sql` — cria `erp_migrator` e `erp_app` sem senha (aborta se já existirem com atributos ou memberships proibidos).
2. **Fora do git:** provisionar a credencial de login de cada role (senha a partir de cofre de segredos, ou IAM database authentication; mecanismo de produção **TBD**).
3. **Admin, uma vez por banco, conectado ao banco do ERP:** `02-bootstrap-database.sql` — `CREATE` em `public` só para `erp_migrator`; `USAGE` para `erp_app`; `CONNECT` explícito.
4. **`erp_migrator`, a cada deploy:** `prisma migrate deploy` (e `npm run db:seed` quando aplicável).
5. **`erp_migrator`, a cada deploy, logo após o passo 4:** `03-runtime-grants.sql` — zera e reaplica a matriz exata de `erp_app` e tira `EXECUTE` de funções.
6. **Aplicação** conecta como `erp_app`.

Todos os scripts são idempotentes. Executar com `psql --single-transaction -v ON_ERROR_STOP=1 -f <arquivo>`.

## Tabela nova

Uma tabela criada por migration nasce **sem nenhum privilégio runtime**. O módulo que a cria precisa declarar a política dela em `03-runtime-grants.sql` e em `RUNTIME_TABLE_PRIVILEGES` (`apps/api/test/integration/table-audit.ts`); sem isso a auditoria do catálogo falha.

## Testes

O setup de integração (`apps/api/test/integration/global-setup.ts`) executa estes mesmos arquivos com roles de nome único por execução (`erp_migrator_t<hex>`, `erp_app_t<hex>`), senhas aleatórias geradas em memória, e remove banco e roles ao final.

## Fronteira

Estes scripts não protegem contra a própria identidade admin nem contra o dono dos objetos (`erp_migrator`), que pode desabilitar triggers ou alterar funções. A proteção é: a aplicação roda como `erp_app`, que não é dona de nada nem membro de `erp_migrator`, e a credencial de `erp_migrator` fica restrita ao pipeline de deploy.

## Ambiente local com Docker Compose

O `docker-compose.yml` da raiz sobe dois servidores PostgreSQL 17 (UTF8), publicados só em `127.0.0.1`:

| Serviço | Porta | Uso |
|---|---|---|
| `postgres-dev` | 5432 | Desenvolvimento local da API; dados persistem no volume `erp_postgres_dev`. Para rodar a API, aplique os scripts 01/02/03 e as migrations conforme a ordem acima. |
| `postgres-test` | 5433 | Servidor **dedicado** aos testes de integração; roda em `tmpfs` e é zerado a cada subida. Não use para desenvolvimento. |

1. Copie `.env.example` para `.env` na raiz e preencha `POSTGRES_DEV_PASSWORD` e `POSTGRES_TEST_PASSWORD` com valores aleatórios.
2. `docker compose up -d` e confira com `docker compose ps` (ambos `healthy`).
3. Testes de integração: `TEST_DATABASE_URL=postgresql://postgres:<POSTGRES_TEST_PASSWORD>@127.0.0.1:5433/postgres`.

O gate oficial roda nesta imagem (`postgres:17` oficial), não em distribuições derivadas (ex.: Supabase).