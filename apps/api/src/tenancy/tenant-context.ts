import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

/**
 * Tenant da operação em curso, já resolvido por uma fonte confiável (no M2, o Auth; hoje, testes e infraestrutura).
 * NÃO é autenticação: quem chama `run()` responde pela origem do tenant. Nunca preencher a partir de header, body,
 * query string ou parâmetro enviado pelo cliente. Campos novos (userId, branchId...) entram só quando houver produtor.
 */
export interface TenantContext {
  readonly tenantId: string;
}

/** Operação tenant-scoped executada fora de um TenantContext. Erro interno: nunca há fallback de tenant. */
export class TenantContextMissingError extends Error {
  override readonly name = "TenantContextMissingError";
  constructor() {
    super("Tenant context is missing: tenant-scoped operations must run inside TenantContextService.run()");
  }
}

/** `tenantId` fora do formato UUID no ponto em que o contexto é criado. */
export class InvalidTenantIdError extends Error {
  override readonly name = "InvalidTenantIdError";
  constructor() {
    super("Invalid tenant id: expected a UUID");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Um único storage por processo: o contexto vive na cadeia assíncrona de cada `run()`, não numa variável mutável.
const storage = new AsyncLocalStorage<TenantContext>();

@Injectable()
export class TenantContextService {
  /**
   * Executa `fn` (síncrona ou assíncrona) com `context` como tenant atual. O contexto acompanha awaits, Promise.all,
   * timers e transações iniciados dentro de `fn`, e não existe fora dela. Um `run()` aninhado substitui o contexto
   * só durante o callback interno; ao terminar, o externo volta a valer.
   */
  run<T>(context: TenantContext, fn: () => T): T {
    if (typeof context?.tenantId !== "string" || !UUID.test(context.tenantId)) throw new InvalidTenantIdError();
    // Cópia congelada só com os campos conhecidos: nada extra do chamador entra, e ninguém altera o contexto depois.
    return storage.run(Object.freeze({ tenantId: context.tenantId.toLowerCase() }), fn);
  }

  /** Contexto atual, ou `undefined` fora de `run()`. Para operações tenant-scoped, usar `requireTenantId()`. */
  current(): TenantContext | undefined {
    return storage.getStore();
  }

  /** Contexto atual; lança `TenantContextMissingError` fora de `run()`. */
  requireContext(): TenantContext {
    const context = storage.getStore();
    if (!context) throw new TenantContextMissingError();
    return context;
  }

  /** Tenant atual; lança `TenantContextMissingError` fora de `run()`. */
  requireTenantId(): string {
    return this.requireContext().tenantId;
  }
}
