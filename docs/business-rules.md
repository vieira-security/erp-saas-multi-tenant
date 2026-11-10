# Regras de negócio

Somente regras fornecidas pelo negócio são registradas aqui. Nenhuma regra fiscal deve ser inventada (ver [fiscal.md](fiscal.md)).

## Organização
- Tenant → Company → Branches e Users.
- No MVP, um tenant começa com uma empresa; a empresa pode ter uma ou mais filiais.
- Funcionário pode acessar mais de uma filial.
- Matrícula é única **dentro do tenant**, não globalmente.

## Dados que não podem ser apagados fisicamente
Vendas, pagamentos, dados fiscais e auditoria nunca são apagados fisicamente (ver [database.md](database.md)).

## Impressão
- Reimpressões devem ser identificadas como tal.
- As últimas comandas ficam acessíveis no PDV.
- Bebidas e produtos prontos podem ser enviados à cozinha conforme configuração.
- Destinos de impressão são configuráveis por filial e por produto.
- NF-e não é impressa automaticamente junto às comandas.

Detalhes: [printing.md](printing.md).

## Catálogo
Três modos de visualização com a mesma lógica de negócio; preferência por funcionário.

## Incidentes
Prioridades P1, P2, P3, P4; registram causa inicial e causa raiz. P1/P2 geram alerta ativo. Detalhes em [deployment.md](deployment.md).

## Pendentes (TBD)
Regras de comanda, caixa, pagamentos, permissões, trial/assinatura, preços e descontos: **TBD — não fornecidas**.
