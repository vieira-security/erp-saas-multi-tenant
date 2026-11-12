import type { AuditAction } from "@erp/contracts";

/**
 * Mesmos valores (e ordem) de `AUDIT_ACTIONS` do contrato: a API só usa `import type` dos pacotes do workspace. O
 * typecheck falha se faltar ou sobrar ação (abaixo) e um teste unitário compara a lista com a do contrato.
 */
export const AUDIT_ACTION_CATALOG = [
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.password.change_failed",
  "auth.lockout.triggered",
  "auth.session.revoked",
  "auth.sessions.revoked",
  "auth.refresh.replay_detected",
  "auth.password.changed",
  "auth.password.reset",
  "user.created",
  "user.updated",
  "user.roles_replaced",
  "user.deactivated",
  "user.activated",
  "user.unlocked",
  "organization.updated",
  "company.created",
  "company.updated",
  "company.activated",
  "company.deactivated",
  "branch.created",
  "branch.updated",
  "branch.activated",
  "branch.deactivated",
  "branch_access.granted",
  "branch_access.revoked",
  "product_category.created",
  "product_category.updated",
  "product_category.activated",
  "product_category.deactivated",
  "product.created",
  "product.updated",
  "product.option_groups_replaced",
  "product.activated",
  "product.deactivated",
  "branch_product_setting.updated",
  "cash_session.opened",
  "cash_session.closed",
  "cash_movement.withdrawal",
  "cash_movement.supply",
  "order.cancelled",
  "kitchen_sector.created",
  "kitchen_sector.updated",
  "kitchen_sector.activated",
  "kitchen_sector.deactivated",
  "kitchen_sector.default_changed",
  "branch_kitchen_sector.updated",
  "kitchen_ticket.reprinted",
] as const satisfies readonly AuditAction[];

type MissingAction = Exclude<AuditAction, (typeof AUDIT_ACTION_CATALOG)[number]>;
const catalogIsComplete: [MissingAction] extends [never] ? true : never = true;
void catalogIsComplete;
