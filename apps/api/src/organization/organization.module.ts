import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ApiExceptionFilter } from "../http/api-error.js";
import { BranchAccessService } from "./branch-access.service.js";
import { BranchService } from "./branch.service.js";
import { CompanyService } from "./company.service.js";
import {
  BranchAccessController,
  BranchesController,
  CompaniesController,
  MeController,
  OrganizationController,
} from "./organization.controllers.js";
import { MePreferencesService } from "./me-preferences.service.js";
import { MeService } from "./me.service.js";
import { OrganizationService } from "./organization.service.js";

/** M3: organização (tenant), companies, branches e acesso de usuários a filiais; GET /me, /me/branches e /me/preferences (KAN-42). */
@Module({
  controllers: [OrganizationController, CompaniesController, BranchesController, MeController, BranchAccessController],
  providers: [OrganizationService, CompanyService, BranchService, BranchAccessService, MeService, MePreferencesService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class OrganizationModule {}
