import { Controller, Get, Inject, Module, Query } from "@nestjs/common";
import type { AuditLogDto, Page } from "@erp/contracts";
import { AuditLogService } from "./audit-log.service.js";
import { parseListAuditLogsQuery } from "./list-audit-logs-query.js";

/**
 * Histórico de auditoria (KAN-41, contrato `packages/contracts/src/audit.ts`). Só leitura: `audit_logs` é append-only e
 * não existe rota de alteração ou exclusão. Sem `@RequirePermissions`: a visibilidade (`audit.read` por filial,
 * `audit.read_tenant` para eventos sem filial, 403 sem nada visível) é decidida no AuditLogService.
 */
@Controller("audit-logs")
export class AuditLogsController {
  constructor(@Inject(AuditLogService) private readonly logs: AuditLogService) {}

  @Get()
  list(@Query() query: unknown): Promise<Page<AuditLogDto>> {
    const { filter, page } = parseListAuditLogsQuery(query);
    return this.logs.list(filter, page);
  }
}

@Module({ controllers: [AuditLogsController], providers: [AuditLogService] })
export class AuditModule {}
