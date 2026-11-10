import { Global, Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.js";
import { TenantScope } from "./tenant-scope.js";

// Global: todo módulo de negócio depende do tenant atual. O produtor do contexto (Auth) entra no M2.
@Global()
@Module({ providers: [TenantContextService, TenantScope], exports: [TenantContextService, TenantScope] })
export class TenancyModule {}
