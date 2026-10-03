# Decisões pendentes (TBD)

Registro único dos pontos em aberto. Resolver antes de implementar o módulo afetado.

| # | Tema | Documento | Bloqueia |
|---|---|---|---|
| 1 | ~~Geração de UUIDv7~~ **Resolvido:** Prisma `@default(uuid(7))`, coluna `uuid` (M1.1) | database | — |
| 2 | Precisão/escala de `numeric` monetário | database | products/payments |
| 3 | Estratégia de remoção por entidade (sem soft delete universal). Já definido: Company sem soft delete, desativação via `status = INACTIVE`, FK Tenant→Company `RESTRICT`; Branch igual (sem soft delete, `INACTIVE`, FKs `RESTRICT`). Em aberto: demais entidades e se Tenant pode ser apagado fisicamente | database | primeiros models |
| 4 | Desenho de idempotency keys (escopo, retenção) | database/offline-edge | offline-sync/orders |
| 5 | Autenticação, sessões, expiração offline | security | auth |
| 6 | Modelo de roles/permissions e fronteiras entre módulos | architecture/security | users |
| 7 | Transmissão de tenant à sessão do banco para RLS (pool, Prisma) | security | ativação da RLS |
| 8 | Escopo da auditoria | security | audit |
| 9 | LGPD x imutabilidade física | security | tenants/users |
| 10 | Hipóteses de dispensa/emissão seletiva de documento fiscal | fiscal | fiscal |
| 11 | Provedor fiscal, certificado, contingência, numeração, retenção de XML | fiscal | fiscal |
| 12 | Operações permitidas offline (cartão, NFC-e, cancelamento) | offline-edge | PDV offline |
| 13 | Reconciliação/conflitos; protocolos PDV↔Edge↔Cloud | offline-edge | offline-sync/Edge |
| 14 | Impressoras/protocolos suportados; falha de impressão | printing | printing |
| 15 | Provedor de billing | architecture | subscriptions |
| 16 | Ferramenta de incidentes; definição/SLAs de P1–P4 | deployment | admin |
| 17 | Ferramentas de teste de integração, responsividade e load | testing-strategy | primeiras features |
| 18 | CI, ambientes, deploy gradual, observabilidade, backup | deployment | primeiro deploy |
| 19 | Ordem de entrega dentro do MVP | product | planejamento |
| 20 | Regras de comanda, caixa, pagamentos, permissões, trial/assinatura | business-rules | respectivos módulos |

## Contradições e riscos identificados
- **Soft delete x imutabilidade x LGPD:** sem soft delete universal e sem remoção física de vendas/fiscal/auditoria, conflita com pedidos de eliminação de dados pessoais (#9).
- **Offline x fiscal/pagamento:** NFC-e exige numeração e comunicação com a SEFAZ; cartão exige autorização. "Offline parcial" precisa definir o que funciona sem internet (#11, #12).
- **Tenant do frontend x offline/Edge:** o tenant deve vir de credencial de dispositivo/sessão, nunca de input livre; a expiração dessa credencial offline é um dilema (#5).
- **RLS + Prisma + pool:** a RLS exige contexto por transação/conexão, que o Prisma não faz nativamente; adiar a RLS não deve levar a um schema que a impeça (#7).
- **UUIDv7:** revela o instante de criação; aceitável para IDs internos, mas avaliar em IDs expostos a terceiros. Gerado só pelo Prisma Client: SQL bruto/ferramentas externas precisam informar o `id` (PostgreSQL < 18 não tem `uuidv7()` nativo).
- **Fuso da sessão x `@prisma/adapter-pg`:** o adapter presume sessão em UTC; `createPrismaClient` fixa `TimeZone=UTC` via parâmetro de startup. Poolers que rejeitam parâmetros de startup (ex.: PgBouncer em modo transação, RDS Proxy) exigirão outra forma de garantir UTC — validar antes de adotar pooler ([database.md](database.md)).
- **Company.timezone sem validação:** o banco aceita qualquer texto (sem lista própria de fusos, por decisão). Um valor inválido só falhará quando usado (ex.: `AT TIME ZONE`); a validação IANA deve entrar na camada de aplicação junto com o primeiro endpoint/serviço de Company.
- **CNPJ:** só formato (14 dígitos) é garantido; dígitos verificadores e unicidade global ficam para etapa posterior.
- **CHECKs fora do schema Prisma:** não aparecem em `migrate diff`; dependem de testes explícitos e de cuidado em migrations futuras ([database.md](database.md)).
- **Índice `companies(tenant_id)` redundante:** `(tenant_id, status)`, a unique `(tenant_id, cnpj)` e a unique `(tenant_id, id)` (M1.3) já começam por `tenant_id`; mantido por decisão do M1.2, candidato a remoção.
- **Troca de tenant de Branch/Company:** a FK composta impede vínculo cruzado, mas mover uma Branch alterando `tenant_id` e `company_id` juntos (de forma consistente) é aceito pelo banco. Se `tenant_id` deve ser imutável, isso exige trigger ou regra de aplicação (não decidido).
- **CNPJ de Branch x Company:** não há relação validada entre o CNPJ da filial e o da empresa (raiz/matriz), nem unicidade entre as duas tabelas.
- **Branch.timezone e Branch.code:** timezone sem validação IANA no banco; code sem normalização (caixa/espaços), então `MORUMBI` e `morumbi` são códigos distintos até a aplicação normalizar.
- **Worker x tenant:** jobs assíncronos também precisam de tenant context explícito, inclusive os disparados por n8n via API.
- **Rollback x migrations destrutivas:** rollback de código só é seguro com migrations retrocompatíveis.
- **Edge "premium" x dados mínimos:** a definição de "dados mínimos" afeta suporte, segurança do dispositivo local e LGPD.
- **Escopo do MVP extenso:** 12 prioridades, incluindo fiscal e offline, sem ordem de entrega definida (#19).
- **Branch base:** esta documentação foi escrita sobre `chore/install-core-frameworks`, ainda não mergeada.

## Antes do Prompt 3
Mínimo recomendado: #1, #3, #5, #6 e #7 (fundação de IDs, remoção, auth e tenant context), mais #19 para definir qual módulo vem primeiro.
