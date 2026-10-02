# Segurança

## Diretrizes
- Secrets fora do código (AWS Secrets Manager em produção).
- `tenant_id` nunca vem livremente do frontend; é derivado do contexto autenticado.

## Isolamento de tenant (decisão aprovada)
- Isolamento obrigatório na camada de aplicação em todo acesso a dados de cliente.
- Banco compartilhado com `tenant_id`; modelagem compatível com PostgreSQL RLS como defesa em profundidade futura (RLS ainda inativa).
- Sem database-per-tenant e sem schema-per-tenant.

## Autenticação/autorização
_A definir. Não implementadas._
