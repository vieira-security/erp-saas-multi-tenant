/**
 * Roles padrão de todo Tenant (docs/database.md, "Role"): templates `is_system = true`, criados no provisionamento.
 * Códigos e nomes exibidos são os documentados; nada além disso foi aprovado.
 */
export const DEFAULT_ROLES = Object.freeze([
  { code: "OWNER", name: "Proprietário" },
  { code: "MANAGER", name: "Gerente" },
  { code: "ATTENDANT", name: "Atendente" },
  { code: "KITCHEN", name: "Cozinha" },
] as const);

export type DefaultRoleCode = (typeof DEFAULT_ROLES)[number]["code"];

/** Permissões concedidas a cada role padrão no provisionamento (códigos de `PERMISSION_CATALOG`). */
export type RolePermissionMatrix = Readonly<Record<DefaultRoleCode, readonly string[]>>;

/**
 * Matriz inicial aprovada (decisão de produto do M2). Regras:
 * - OWNER recebe as 19 permissões do catálogo ATUAL, listadas explicitamente. Ele NÃO recebe permissões futuras
 *   automaticamente: toda permissão nova do catálogo precisa ser adicionada aqui, role a role, por decisão explícita
 *   (um teste falha se uma permissão do catálogo não estiver em nenhuma role).
 * - O provisionamento só ACRESCENTA vínculos (nunca remove) e nunca toca role customizada que use um código padrão.
 * - Regra futura de administração (sem endpoint ainda): um usuário não pode conceder role/permissão com autoridade
 *   superior à sua própria (ex.: MANAGER tem `user.manage`, mas não pode atribuir OWNER nem uma role com permissão que
 *   ele mesmo não tem).
 */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissionMatrix = Object.freeze({
  OWNER: Object.freeze([
    "organization.read",
    "organization.manage",
    "branch.read",
    "branch.manage",
    "user.read",
    "user.manage",
    "role.read",
    "role.manage",
    "product.read",
    "product.manage",
    "order.read",
    "order.create",
    "order.cancel",
    "cash.read",
    "cash.open",
    "cash.close",
    "fiscal.read",
    "fiscal.issue",
    "fiscal.cancel",
  ]),
  MANAGER: Object.freeze([
    "organization.read",
    "branch.read",
    "user.read",
    "user.manage",
    "role.read",
    "product.read",
    "product.manage",
    "order.read",
    "order.create",
    "order.cancel",
    "cash.read",
    "cash.open",
    "cash.close",
    "fiscal.read",
    "fiscal.issue",
    "fiscal.cancel",
  ]),
  ATTENDANT: Object.freeze([
    "branch.read",
    "product.read",
    "order.read",
    "order.create",
    "cash.read",
    "cash.open",
    "fiscal.read",
    "fiscal.issue",
  ]),
  KITCHEN: Object.freeze(["product.read", "order.read"]),
});
