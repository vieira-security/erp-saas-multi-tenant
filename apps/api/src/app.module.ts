import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({ imports: [TenancyModule], controllers: [HealthController] })
export class AppModule {}
