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
 * DECISION REQUIRED — default role permission matrix. A distribuição de permissões entre OWNER, MANAGER, ATTENDANT e
 * KITCHEN não foi aprovada (docs/open-questions.md, "Pendências do RolePermission", item 2). Nenhuma permissão é
 * inventada, nem para OWNER: as quatro roles nascem sem permissão até a matriz ser decidida. Preencher aqui é a única
 * mudança necessária; o provisionamento só ACRESCENTA vínculos (nunca remove) e pode ser reexecutado.
 */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissionMatrix = Object.freeze({
  OWNER: [],
  MANAGER: [],
  ATTENDANT: [],
  KITCHEN: [],
});
