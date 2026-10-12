import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { AuthorizationModule } from "./authorization/authorization.module.js";
import { TenantsModule } from "./tenants/tenants.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({ imports: [TenancyModule, DatabaseModule, AuthorizationModule, AuthModule, TenantsModule], controllers: [HealthController] })
export class AppModule {}
