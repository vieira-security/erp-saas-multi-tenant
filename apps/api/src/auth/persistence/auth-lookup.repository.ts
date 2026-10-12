import type { DeviceStatus, PrismaClient, TenantStatus } from "../../generated/prisma/client.js";
import type { TenantScope } from "../../tenancy/tenant-scope.js";

export interface DeviceRef {
  readonly id: string;
  readonly status: DeviceStatus;
}

/** Dispositivos do tenant atual. `device_key` é identificador, NÃO segredo: localizar por ele não autentica nada. */
export class AuthDeviceRepository {
  constructor(
    private readonly db: Pick<PrismaClient, "device">,
    private readonly scope: TenantScope,
  ) {}

  async findByKey(deviceKey: string): Promise<DeviceRef | null> {
    return this.db.device.findFirst({ where: this.scope.where({ deviceKey }), select: { id: true, status: true } });
  }
}

/**
 * Status do Tenant (MODEL_SCOPE `root`: sem filtro de tenant por definição). Só o Auth consulta, para o tenant que ele
 * próprio resolveu (resolver confiável no login; sessão/token verificados depois).
 */
export class AuthTenantRepository {
  constructor(private readonly db: Pick<PrismaClient, "tenant">) {}

  async findStatus(tenantId: string): Promise<TenantStatus | null> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
    return tenant?.status ?? null;
  }
}
