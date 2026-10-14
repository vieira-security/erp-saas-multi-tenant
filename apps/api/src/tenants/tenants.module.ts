import { Module } from "@nestjs/common";
import { TenantProvisioningService } from "./tenant-provisioning.service.js";

/** Ciclo de vida do tenant. Hoje só o provisionamento das roles padrão (sem endpoint: criação de tenant não existe ainda). */
@Module({ providers: [TenantProvisioningService], exports: [TenantProvisioningService] })
export class TenantsModule {}
