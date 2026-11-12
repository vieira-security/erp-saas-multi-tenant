import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import type { BranchKitchenSectorDto, KitchenSectorDto, KitchenTicketDto, KitchenTicketPrintDto, Page } from "@erp/contracts";
import { RequireBranchPermissions, RequirePermissions } from "../authorization/permission.guard.js";
import { KitchenSectorStatus } from "../generated/prisma/client.js";
import { NotFoundError } from "../http/api-error.js";
import { UUID, bool, optional, parseInput, required, text, uuid } from "../http/input.js";
import { pageQuerySpec, pageRequest } from "../http/paging.js";
import { businessDateQuery } from "../orders/validation.js";
import { KitchenSectorService } from "./kitchen-sector.service.js";
import { KitchenTicketService } from "./kitchen-ticket.service.js";
import { KITCHEN_SECTOR_NAME_MAX_LENGTH, sectorCode, sectorSortOrder, ticketStatusList } from "./validation.js";

/**
 * HTTP do M7 (contrato em `@erp/contracts`, kitchen.ts). Controllers só fazem parsing estrito + autorização declarativa
 * por código de permissão e delegam aos services. Setores em escopo de TENANT (`product.read`/`product.manage`); rotas
 * `/branches/:branchId/...` em escopo de FILIAL (UserBranchAccess; sem acesso, filial de outro tenant ou inexistente = 403).
 */

/** Id de rota fora do formato UUID = recurso inexistente (404), sem consultar o banco. */
function routeId(value: string, resource: string): string {
  if (!UUID.test(value)) throw new NotFoundError(resource);
  return value.toLowerCase();
}

@Controller("kitchen-sectors")
export class KitchenSectorsController {
  constructor(@Inject(KitchenSectorService) private readonly sectors: KitchenSectorService) {}

  @Get()
  @RequirePermissions("product.read")
  list(@Query() query: unknown): Promise<KitchenSectorDto[]> {
    parseInput(query, {}, "query");
    return this.sectors.list();
  }

  @Post()
  @RequirePermissions("product.manage")
  create(@Body() body: unknown): Promise<KitchenSectorDto> {
    const input = parseInput(body, {
      name: required(text(KITCHEN_SECTOR_NAME_MAX_LENGTH)),
      code: required(sectorCode),
      sortOrder: optional(sectorSortOrder),
    });
    return this.sectors.create(input);
  }

  @Patch(":sectorId")
  @RequirePermissions("product.manage")
  update(@Param("sectorId") sectorId: string, @Body() body: unknown): Promise<KitchenSectorDto> {
    const id = routeId(sectorId, "Kitchen sector");
    const changes = parseInput(body, {
      name: optional(text(KITCHEN_SECTOR_NAME_MAX_LENGTH)),
      code: optional(sectorCode),
      sortOrder: optional(sectorSortOrder),
    });
    return this.sectors.update(id, changes);
  }

  @Post(":sectorId/make-default")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  makeDefault(@Param("sectorId") sectorId: string): Promise<KitchenSectorDto> {
    return this.sectors.makeDefault(routeId(sectorId, "Kitchen sector"));
  }

  @Post(":sectorId/activate")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  activate(@Param("sectorId") sectorId: string): Promise<KitchenSectorDto> {
    return this.sectors.setStatus(routeId(sectorId, "Kitchen sector"), KitchenSectorStatus.ACTIVE);
  }

  @Post(":sectorId/deactivate")
  @HttpCode(200)
  @RequirePermissions("product.manage")
  deactivate(@Param("sectorId") sectorId: string): Promise<KitchenSectorDto> {
    return this.sectors.setStatus(routeId(sectorId, "Kitchen sector"), KitchenSectorStatus.INACTIVE);
  }
}

/** Escopo de FILIAL: o guard exige a permissão NA filial `:branchId` (UserBranchAccess), mesmo com role tenant-wide. */
@Controller("branches/:branchId")
export class BranchKitchenController {
  constructor(
    @Inject(KitchenSectorService) private readonly sectors: KitchenSectorService,
    @Inject(KitchenTicketService) private readonly tickets: KitchenTicketService,
  ) {}

  @Get("kitchen-sectors")
  @RequireBranchPermissions("branchId", "product.read")
  listSectors(@Param("branchId") branchId: string): Promise<BranchKitchenSectorDto[]> {
    return this.sectors.listForBranch(routeId(branchId, "Branch"));
  }

  @Put("kitchen-sectors/:sectorId")
  @RequireBranchPermissions("branchId", "product.manage")
  setSector(@Param("branchId") branchId: string, @Param("sectorId") sectorId: string, @Body() body: unknown): Promise<BranchKitchenSectorDto> {
    const branch = routeId(branchId, "Branch");
    const sector = routeId(sectorId, "Kitchen sector");
    const input = parseInput(body, { enabled: required(bool) });
    return this.sectors.setForBranch(branch, sector, input.enabled);
  }

  @Get("kitchen-tickets")
  @RequireBranchPermissions("branchId", "order.read")
  listTickets(@Param("branchId") branchId: string, @Query() query: unknown): Promise<Page<KitchenTicketDto>> {
    const { sectorId, status, businessDate, ...paging } = parseInput(
      query,
      { ...pageQuerySpec, sectorId: optional(uuid), status: optional(ticketStatusList), businessDate: optional(businessDateQuery) },
      "query",
    );
    return this.tickets.list(
      routeId(branchId, "Branch"),
      { ...(sectorId ? { sectorId } : {}), ...(status ? { statuses: status } : {}), ...(businessDate ? { businessDate } : {}) },
      pageRequest(paging),
    );
  }

  @Get("kitchen-tickets/:ticketId")
  @RequireBranchPermissions("branchId", "order.read")
  getTicket(@Param("branchId") branchId: string, @Param("ticketId") ticketId: string): Promise<KitchenTicketDto> {
    return this.tickets.get(routeId(branchId, "Branch"), routeId(ticketId, "Kitchen ticket"));
  }

  @Post("kitchen-tickets/:ticketId/start")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.prepare")
  start(@Param("branchId") branchId: string, @Param("ticketId") ticketId: string): Promise<KitchenTicketDto> {
    return this.tickets.advance(routeId(branchId, "Branch"), routeId(ticketId, "Kitchen ticket"), "start");
  }

  @Post("kitchen-tickets/:ticketId/ready")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.prepare")
  ready(@Param("branchId") branchId: string, @Param("ticketId") ticketId: string): Promise<KitchenTicketDto> {
    return this.tickets.advance(routeId(branchId, "Branch"), routeId(ticketId, "Kitchen ticket"), "ready");
  }

  @Post("kitchen-tickets/:ticketId/print")
  @HttpCode(200)
  @RequireBranchPermissions("branchId", "order.read")
  print(@Param("branchId") branchId: string, @Param("ticketId") ticketId: string): Promise<KitchenTicketPrintDto> {
    return this.tickets.print(routeId(branchId, "Branch"), routeId(ticketId, "Kitchen ticket"));
  }
}
