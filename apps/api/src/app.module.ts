import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { AuthorizationModule } from "./authorization/authorization.module.js";
import { CashModule } from "./cash/cash.module.js";
import { ClockModule } from "./clock/clock.js";
import { TenantsModule } from "./tenants/tenants.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { KitchenModule } from "./kitchen/kitchen.module.js";
import { OrdersModule } from "./orders/orders.module.js";
import { OrganizationModule } from "./organization/organization.module.js";
import { ProductsModule } from "./products/products.module.js";
import { RolesModule } from "./roles/roles.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";
import { UsersModule } from "./users/users.module.js";

@Module({ imports: [TenancyModule, DatabaseModule, ClockModule, AuthorizationModule, AuthModule, TenantsModule, OrganizationModule, UsersModule, RolesModule, ProductsModule, KitchenModule, OrdersModule, CashModule], controllers: [HealthController] })
export class AppModule {}
