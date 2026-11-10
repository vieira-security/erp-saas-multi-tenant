# Ambiente local: do zero até logar no frontend

Passo a passo para subir PostgreSQL, API e web localmente com o **seed de desenvolvimento** (KAN-51): um tenant demo
com usuários de todas as roles padrão e um cardápio pequeno. Validado num banco de dev limpo (PostgreSQL 17 do
`docker-compose.yml`). Nenhuma senha real fica no git: `.env` e `.env.*` estão no `.gitignore`.

Pré-requisitos: Node >= 22, npm, Docker. `npm install` na raiz. Os comandos abaixo são para bash (Git Bash no Windows);
há a variante PowerShell onde muda algo.

## 1. PostgreSQL (`postgres-dev`, porta 5432)

```bash
cp .env.example .env          # raiz: preencha POSTGRES_DEV_PASSWORD e POSTGRES_TEST_PASSWORD (aleatórias)
docker compose up -d postgres-dev
docker compose ps             # postgres-dev "healthy"
```

## 2. Identidades e privilégios (uma vez por banco)

Mesmos scripts de produção (`infrastructure/postgres/`), executados com o `psql` do próprio container:

```bash
docker exec -i erp-postgres-dev psql -U postgres -d erp --single-transaction -v ON_ERROR_STOP=1 -f - < infrastructure/postgres/01-bootstrap-roles.sql
docker exec -i erp-postgres-dev psql -U postgres -d erp --single-transaction -v ON_ERROR_STOP=1 -f - < infrastructure/postgres/02-bootstrap-database.sql
# Senhas SÓ locais das duas roles (escolha as suas; guarde nos .env do passo 3):
docker exec -i erp-postgres-dev psql -U postgres -d erp -v ON_ERROR_STOP=1 -c "ALTER ROLE erp_migrator PASSWORD '<senha-migrator>'"
docker exec -i erp-postgres-dev psql -U postgres -d erp -v ON_ERROR_STOP=1 -c "ALTER ROLE erp_app PASSWORD '<senha-app>'"
```

## 3. Variáveis da API (dois arquivos, duas identidades)

A API e os seeds leem a mesma variável `DATABASE_URL`, mas com identidades diferentes: o **runtime** conecta como
`erp_app`; migrations e seeds como `erp_migrator` (nunca o contrário). Por isso são dois arquivos em `apps/api/`:

`apps/api/.env` (runtime da API):

```dotenv
DATABASE_URL=postgresql://erp_app:<senha-app>@127.0.0.1:5432/erp
AUTH_ACCESS_TOKEN_SECRET=<node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">
AUTH_ALLOWED_ORIGINS=http://localhost:3000
AUTH_COOKIE_SECURE=false
```

`apps/api/.env.migrator` (migrations e seeds):

```dotenv
DATABASE_URL=postgresql://erp_migrator:<senha-migrator>@127.0.0.1:5432/erp
ALLOW_DEV_SEED=true
DEV_SEED_PASSWORD=<escolha a sua, mínimo 8 caracteres>
```

## 4. Migrations, grants e seeds (como `erp_migrator`)

```bash
cd apps/api
set -a; . ./.env.migrator; set +a      # carrega o .env.migrator SÓ neste terminal
npx prisma migrate deploy
docker exec -i erp-postgres-dev psql -U erp_migrator -d erp --single-transaction -v ON_ERROR_STOP=1 -f - < ../../infrastructure/postgres/03-runtime-grants.sql
npm run db:seed        # catálogo de permissões (o mesmo de produção)
npm run db:seed:dev    # tenant demo (idempotente: pode rodar de novo, só completa o que faltar)
```

PowerShell, para carregar o arquivo no terminal atual (no lugar do `set -a`):

```powershell
Get-Content .env.migrator | Where-Object { $_ -match '^\s*([^#=\s]+)=(.*)$' } | ForEach-Object { Set-Item "env:$($Matches[1])" $Matches[2] }
```

Use um terminal **separado** para o passo 5: com `DATABASE_URL` do migrator no ambiente, a API subiria como
`erp_migrator` (o `--env-file` não sobrescreve variável já definida).

O `db:seed:dev` recusa rodar com `NODE_ENV=production`, sem `ALLOW_DEV_SEED=true` ou sem `DEV_SEED_PASSWORD`.

## 5. API (porta 3001) e web (porta 3000)

```bash
npm run dev -w @erp/api -- --env-file .env   # terminal novo, na raiz; http://localhost:3001/health -> {"status":"ok"}
npm run dev -w @erp/web                      # http://localhost:3000
```

O login exige que web e API pareçam o mesmo site (cookie `SameSite=Strict` + checagem de `Origin`): o web acessa a API
pelo proxy do Next (KAN-53, tarefa do frontend). Teste direto na API:

```bash
curl -i -X POST http://localhost:3001/auth/login -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"loginCode":"DEMO","employeeNumber":"CAIXA1","password":"<DEV_SEED_PASSWORD>"}'
curl http://localhost:3001/me -H 'Authorization: Bearer <accessToken>'
```

## Dados demo (`npm run db:seed:dev`)

Organização **Restaurante Demo**, código de login **`DEMO`**, status `ACTIVE`; empresa CNPJ `12ABC34501DE35`
(alfanumérico de exemplo da Receita), timezone `America/Sao_Paulo`. Todos os usuários usam a senha de
`DEV_SEED_PASSWORD`; roles tenant-wide.

| Matrícula | Role | Filiais com acesso | Observação |
|---|---|---|---|
| `DONO` | OWNER | CENTRO, SHOPPING, ANTIGA | |
| `GERENTE` | MANAGER | CENTRO, SHOPPING | |
| `CAIXA1` | ATTENDANT | CENTRO | |
| `CAIXA2` | ATTENDANT | SHOPPING | |
| `COZINHA` | KITCHEN | CENTRO | |
| `TROCASENHA` | ATTENDANT | CENTRO | `mustChangePassword: true` (fluxo de troca de senha) |

Filiais: `CENTRO` e `SHOPPING` (ACTIVE), `ANTIGA` (INACTIVE: aparece em `GET /me` com `operable: false`).

Cardápio: categorias Lanches, Bebidas e Sobremesas; 10 produtos com código: `REFRI`, `SUCO`, `AGUA`, `BATATA`
(variação Tamanho P/M/G, mín 1 máx 1), `XSALADA` (adicionais, mín 0 máx 3), `XBURGER` (R$ 27,90 na SHOPPING),
`COMBO1` (bebida vinculada a REFRI/SUCO/AGUA), `HOTDOG` (INACTIVE), `PUDIM` (indisponível na SHOPPING), `SORVETE`.

## Recomeçar do zero

```bash
docker compose rm -sf postgres-dev
docker volume ls | grep erp_postgres_dev           # ex.: erp-saasmulti-tenant_erp_postgres_dev (prefixo = pasta do repo)
docker volume rm <nome-do-volume>
```
