# Produto

ERP SaaS multi-tenant para pequenas e médias lojas/restaurantes de alimentação em shopping centers no Brasil.

> Convenção: `TBD` = decisão pendente. Todos os TBDs estão consolidados em [open-questions.md](open-questions.md).

## Prioridades do MVP
1. Atendimento rápido.
2. PDV.
3. Produtos/cardápio.
4. Caixa e pagamentos.
5. Comandas.
6. Impressão.
7. Usuários e permissões.
8. Funcionamento offline parcial.
9. NFC-e.
10. NF-e.
11. Trial/assinatura.
12. Administração SaaS.

A lista acima é o conjunto fornecido. Se ela representa também a ordem de entrega: **TBD**.

## Marcos de implementação
- **M1 — Core multi-tenant ✅** Tenant, Company, Branch, User, UserBranchAccess, Role, Permission, RolePermission, UserRole, Device, Session e AuditLog no PostgreSQL, com isolamento por `tenant_id` garantido no banco, `tenant_id` imutável, `audit_logs` append-only e identidades `erp_migrator`/`erp_app` ([database.md](database.md)). Encerrado pelo gate M1.14.4 ([open-questions.md](open-questions.md)).
- **M2 — Auth e autorização runtime:** implementado (M2.1–M2.14) e auditado no gate final: **aprovado com decisões de produto pendentes**. Login por matrícula + senha (core, sem endpoint público até a decisão sobre descoberta do tenant), sessões com refresh rotativo, guards globais, autorização por permissão/filial, roles padrão (matriz pendente), troca/reset de senha, lockout ([security.md](security.md)). Decisões pendentes em [open-questions.md](open-questions.md) ("Decisões pendentes do M2").

## Fora do MVP
Compras, recebimento e estoque ficam para versões futuras.

## Estrutura organizacional do cliente
```mermaid
flowchart TD
  T[Tenant] --> C[Company]
  C --> B[Branches]
  C --> U[Users]
  U -. acesso a 1..N .-> B
```
- No MVP, um tenant começa com **uma** empresa.
- Uma empresa tem uma ou mais filiais.
- Um funcionário pode acessar mais de uma filial.
- A matrícula é única dentro do tenant, não globalmente.

## Experiência do catálogo (PDV/Frontend)
Três modos de visualização: **compacto**, **lista** e **imagens**. A preferência é individual por funcionário. A lógica de negócio é a mesma em todos os modos. Imagens são opcionais.

## Perfis de acesso ao produto
- Cliente (operação da loja/restaurante).
- Administração SaaS (equipe interna): tenants, trial/assinatura, incidentes.

Detalhes funcionais de cada área: **TBD** (entram em [business-rules.md](business-rules.md) quando fornecidos).
