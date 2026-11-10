import { isIP } from "node:net";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { TenantScope } from "../tenancy/tenant-scope.js";

/**
 * Eventos de segurança do Auth e da gestão de funcionários gravados em `audit_logs`. Camada mínima e segura (docs/security.md, "metadata nunca guarda
 * credenciais"): cada evento é um tipo fechado e o `metadata` é montado aqui, a partir de uma ALLOWLIST de chaves com
 * valores enumerados/UUID/inteiros. Nunca recebe objeto de request/DTO, senha, matrícula digitada, token ou hash.
 */
export type SessionRevocationReason =
  | "logout"
  | "admin"
  | "password_changed"
  | "password_reset"
  | "replay_detected"
  | "device_revoked"
  | "user_disabled";

/**
 * Atribuição de role nos metadados de `user.roles_replaced`: `<roleId>` (tenant inteiro) ou `<roleId>:<branchId>`.
 * Só UUIDs: nunca nome/código de role nem dado digitado.
 */
export type RoleAssignmentRef = string;

export type SecurityAuditEvent =
  | { action: "auth.login.succeeded"; userId: string; sessionId: string; deviceId: string | null }
  | {
      action: "auth.login.failed";
      /** `null` quando a matrícula não existe: a matrícula digitada NÃO é registrada (pode ser uma senha digitada no campo errado). */
      userId: string | null;
      deviceId: string | null;
      reason: "invalid_credentials" | "account_disabled" | "account_locked" | "temporarily_locked" | "device_not_allowed";
    }
  | { action: "auth.password.change_failed"; userId: string; deviceId: string | null }
  | { action: "auth.lockout.triggered"; userId: string; lockedUntil: Date }
  | { action: "auth.session.revoked"; sessionId: string; actorUserId: string | null; reason: SessionRevocationReason }
  | { action: "auth.sessions.revoked"; userId: string; actorUserId: string | null; reason: SessionRevocationReason; count: number }
  | { action: "auth.refresh.replay_detected"; sessionId: string; userId: string; deviceId: string | null }
  | { action: "auth.password.changed"; userId: string }
  | { action: "auth.password.reset"; targetUserId: string; actorUserId: string }
  // Gestão de funcionários: ator em `user_id`, alvo em `resource_id`. Sem nome, matrícula, senha ou hash.
  | { action: "user.created"; targetUserId: string; actorUserId: string }
  | { action: "user.updated"; targetUserId: string; actorUserId: string }
  | { action: "user.roles_replaced"; targetUserId: string; actorUserId: string; added: readonly RoleAssignmentRef[]; removed: readonly RoleAssignmentRef[] }
  | { action: "user.deactivated"; targetUserId: string; actorUserId: string }
  | { action: "user.activated"; targetUserId: string; actorUserId: string }
  | { action: "user.unlocked"; targetUserId: string; actorUserId: string };

export interface AuditClientInfo {
  readonly ipAddress?: string | null;
}

type AuditRow = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  userId: string | null;
  deviceId: string | null;
  metadata: Record<string, string | number | readonly string[]> | null;
};

/** Chaves aceitas em `metadata` de evento de segurança. Qualquer outra chave é bug e falha (fail-closed). */
const METADATA_KEYS = new Set(["reason", "count", "locked_until"]);
const SAFE_VALUE = /^[a-z0-9_:.\-TZ]+$/i;
/** Chaves de LISTA de atribuições de role (`user.roles_replaced`): só referências `uuid` ou `uuid:uuid`, no máximo 50. */
const ROLE_REF_LIST_KEYS = new Set(["roles_added", "roles_removed"]);
const ROLE_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;
const ROLE_REF_LIST_MAX = 50;

export class UnsafeAuditMetadataError extends Error {
  override readonly name = "UnsafeAuditMetadataError";
  constructor(key: string) {
    super(`Audit metadata key not allowed: ${key}`);
  }
}

/** Defesa em profundidade: mesmo montado internamente, o metadata é conferido antes de gravar. */
export function assertSafeAuditMetadata(metadata: Record<string, unknown>): void {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new UnsafeAuditMetadataError("<root>");
  for (const [key, value] of Object.entries(metadata)) {
    if (ROLE_REF_LIST_KEYS.has(key)) {
      const ok = Array.isArray(value) && value.length <= ROLE_REF_LIST_MAX && value.every((ref) => typeof ref === "string" && ROLE_REF.test(ref));
      if (!ok) throw new UnsafeAuditMetadataError(key);
      continue;
    }
    if (!METADATA_KEYS.has(key)) throw new UnsafeAuditMetadataError(key);
    const ok =
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && value.length <= 64 && SAFE_VALUE.test(value));
    if (!ok) throw new UnsafeAuditMetadataError(key);
  }
}

function toRow(event: SecurityAuditEvent): AuditRow {
  switch (event.action) {
    case "auth.login.succeeded":
      return { action: event.action, resourceType: "session", resourceId: event.sessionId, userId: event.userId, deviceId: event.deviceId, metadata: null };
    case "auth.login.failed":
      return { action: event.action, resourceType: "user", resourceId: event.userId, userId: event.userId, deviceId: event.deviceId, metadata: { reason: event.reason } };
    case "auth.password.change_failed":
      return { action: event.action, resourceType: "user", resourceId: event.userId, userId: event.userId, deviceId: event.deviceId, metadata: null };
    case "auth.lockout.triggered":
      return { action: event.action, resourceType: "user", resourceId: event.userId, userId: event.userId, deviceId: null, metadata: { locked_until: event.lockedUntil.toISOString() } };
    case "auth.session.revoked":
      return { action: event.action, resourceType: "session", resourceId: event.sessionId, userId: event.actorUserId, deviceId: null, metadata: { reason: event.reason } };
    case "auth.sessions.revoked":
      return { action: event.action, resourceType: "user", resourceId: event.userId, userId: event.actorUserId, deviceId: null, metadata: { reason: event.reason, count: event.count } };
    case "auth.refresh.replay_detected":
      return { action: event.action, resourceType: "session", resourceId: event.sessionId, userId: event.userId, deviceId: event.deviceId, metadata: null };
    case "auth.password.changed":
      return { action: event.action, resourceType: "user", resourceId: event.userId, userId: event.userId, deviceId: null, metadata: null };
    case "auth.password.reset":
    case "user.created":
    case "user.updated":
    case "user.deactivated":
    case "user.activated":
    case "user.unlocked":
      return { action: event.action, resourceType: "user", resourceId: event.targetUserId, userId: event.actorUserId, deviceId: null, metadata: null };
    case "user.roles_replaced":
      return {
        action: event.action,
        resourceType: "user",
        resourceId: event.targetUserId,
        userId: event.actorUserId,
        deviceId: null,
        metadata: { roles_added: [...event.added], roles_removed: [...event.removed] },
      };
  }
}

/** IP validado (o banco rejeita `inet` inválido; aqui um valor inválido vira `null` em vez de derrubar a operação). */
export function normalizeIp(ip: string | null | undefined): string | null {
  return typeof ip === "string" && isIP(ip) !== 0 ? ip : null;
}

/** Grava eventos de segurança no tenant atual (TenantScope). Recebe o client da transação quando houver. */
export class SecurityAuditWriter {
  constructor(
    private readonly db: Pick<PrismaClient, "auditLog">,
    private readonly scope: TenantScope,
  ) {}

  async record(event: SecurityAuditEvent, client: AuditClientInfo = {}): Promise<void> {
    const row = toRow(event);
    if (row.metadata) assertSafeAuditMetadata(row.metadata);
    await this.db.auditLog.create({
      data: this.scope.data({
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        userId: row.userId,
        deviceId: row.deviceId,
        ...(row.metadata ? { metadata: row.metadata as Prisma.InputJsonObject } : {}),
        ipAddress: normalizeIp(client.ipAddress),
      }),
    });
  }
}
