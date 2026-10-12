# Deploy

## Fluxo
- `main` estável; branches curtas; toda mudança por Pull Request.
- CI (lint, typecheck, test, build) antes do merge. Pipeline de CI: **TBD** (ainda não existe).
- Deploy gradual.

## Operação
- Manutenção relevante é avisada dentro do ERP.
- Pedidos em andamento não podem ser perdidos durante deploy/manutenção.
- Migrations compatíveis sempre que possível (expand/contract); destrutivas exigem revisão explícita.
- Rollback ou desativação da feature (feature flag) quando aplicável.

## Banco de dados: identidades e ordem (M1.14.2b)
Scripts e detalhes em [`infrastructure/postgres/README.md`](../infrastructure/postgres/README.md); matriz de privilégios em [database.md](database.md).

1. **Provisionamento (uma vez):** a identidade admin (superusuário self-hosted ou master do RDS) executa `01-bootstrap-roles.sql` no cluster e `02-bootstrap-database.sql` no banco do ERP.
2. **Credenciais:** login de `erp_migrator` e `erp_app` provisionado fora do git (mecanismo de produção **TBD**: Secrets Manager ou IAM database authentication).
3. **Cada deploy, como `erp_migrator`:** `prisma migrate deploy`, `npm run db:seed` quando aplicável e `03-runtime-grants.sql`, nessa ordem e antes de a nova versão receber tráfego.
4. **Runtime:** API e workers com `DATABASE_URL` de `erp_app`. Nunca usar a identidade admin nem `erp_migrator` na aplicação.
5. **Segredos do Auth (M2):** `AUTH_ACCESS_TOKEN_SECRET` (>= 32 bytes aleatórios, por ambiente, do cofre de segredos) é obrigatório; ausente ou fraco, a API não sobe. Trocar a chave invalida todos os access tokens **e todos os refresh tokens** (a prova HMAC do refresh é derivada dela): na prática, todos precisam logar de novo. TTLs opcionais `AUTH_ACCESS_TOKEN_TTL_SECONDS`/`AUTH_REFRESH_TOKEN_TTL_SECONDS`. Rotação de chave sem invalidação (múltiplas chaves/`kid`) ainda não existe. Nomes em `apps/api/.env.example`.
6. **Dependência nativa (`argon2`):** o pacote traz binários N-API pré-compilados (linux-x64 e linux-arm64 glibc/musl, linux-arm, win32-x64, darwin-arm64, freebsd) e os carrega em runtime via `node-gyp-build`. O `allow-scripts` do npm 11 bloqueia o script de install (`node-gyp-build`), que só serviria para COMPILAR quando não há binário; nas plataformas listadas isso não muda nada e a instalação fica reprodutível pelo `package-lock.json` (integridade do tarball). Não aprovar o script (`npm approve-scripts argon2`) a menos que a imagem seja de plataforma sem binário (ex.: macOS Intel, Windows ARM), caso em que ela precisa de toolchain C++/Python. Plataforma sem binário falha no import e a API não sobe (fail-fast); os testes unitários de hashing e o smoke de boot detectam isso no CI.

Uma migration que cria tabela exige atualizar `03-runtime-grants.sql` no mesmo PR; sem isso, a tabela fica inacessível para a aplicação e a auditoria de testes falha.

## Alvo futuro (não implementado)
AWS ECS/Fargate, RDS PostgreSQL, Redis, SQS, S3, Secrets Manager, CloudWatch. O backend stateless facilita a escala horizontal.

## Incidentes
- O ERP é a origem do chamado do cliente; ferramenta Kanban externa para a equipe (principal **TBD**; Jira segunda opção).
- Prioridades **P1, P2, P3, P4**; registrar causa inicial e causa raiz.
- P1/P2 geram alerta ativo; incidentes globais podem agrupar vários clientes.
- Definição e SLAs de cada prioridade: **TBD**.

## Pendências (TBD)
Ambientes (dev/staging/prod), estratégia de deploy gradual (canary/blue-green), observabilidade, backup/restore, estratégia de feature flags, provedor de billing ([architecture.md](architecture.md)).
