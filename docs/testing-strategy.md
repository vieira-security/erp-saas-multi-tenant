# Estratégia de testes

- Toda feature relevante possui testes.
- Antes do PR: lint, typecheck e testes relacionados.
- Runner padrão: Vitest nos workspaces TypeScript (`npm test`). Não usar Jest.
- Playwright (E2E) será configurado quando houver frontend funcional.
- Testes atuais são apenas smoke de bootstrap.

## Pirâmide, isolamento de tenant, E2E
_A definir. Nada aqui foi decidido além do que está explicitamente registrado._
