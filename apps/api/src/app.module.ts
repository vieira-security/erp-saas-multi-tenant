import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({ imports: [TenancyModule, DatabaseModule, AuthModule], controllers: [HealthController] })
export class AppModule {}
