import { Global, Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.js";

// Global: todo módulo de negócio depende do tenant atual. O produtor do contexto (Auth) entra no M2.
@Global()
@Module({ providers: [TenantContextService], exports: [TenantContextService] })
export class TenancyModule {}
