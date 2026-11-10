# Offline e Edge

## Princípios
- Web **PWA-first**.
- Offline **parcial**, com foco na continuidade do **PDV**. O backoffice **não** é offline-first.
- A cloud é a fonte definitiva dos dados após reconciliação.

## PDV offline (preparação, não implementado)
- Cache local dos dados necessários à operação.
- IndexedDB para continuidade operacional.
- Fila local de operações.
- UUIDv7 gerado no cliente.
- Idempotency keys para evitar duplicidade.
- Sincronização posterior e operação parcial durante falha de internet.

```mermaid
sequenceDiagram
  participant PDV as PDV (PWA + IndexedDB)
  participant API as API
  PDV->>PDV: operação offline (UUIDv7 + idempotency key) vai para a fila local
  Note over PDV: sem internet
  PDV->>API: reenvio da fila (internet volta)
  API->>API: deduplica por idempotency key (por tenant)
  API-->>PDV: confirmação ou conflito
  PDV->>PDV: remove da fila / trata conflito
```

## Edge Server (opcional e premium) — NÃO implementar agora
- Servidor local opcional, usado por vários PDVs.
- Mantém dados mínimos de operação e fila de sincronização.
- Impressão local.
- Tecnologia prevista: **Node.js + TypeScript**; SQLite local é opção prevista.
- **Não** replica o PostgreSQL inteiro.
- A cloud continua fonte definitiva após reconciliação.

```mermaid
flowchart LR
  P1[PDV 1] --> E[Edge Server]
  P2[PDV 2] --> E
  E --> PR[Impressão local]
  E <-.->|sync| C[Cloud API]
  P1 -.->|se Edge indisponível| C
```

## Pendências (TBD)
- Escopo exato dos dados em cache e política de expiração.
- Operações permitidas offline (pagamento em cartão, NFC-e, desconto, cancelamento).
- Resolução de conflitos e reconciliação.
- Autenticação/permissões com sessão expirada offline.
- Emissão fiscal offline ([fiscal.md](fiscal.md)).
- Protocolo PDV↔Edge e Edge↔Cloud; empacotamento do Edge.
