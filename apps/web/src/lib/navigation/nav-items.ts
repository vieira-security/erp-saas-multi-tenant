import type { MeDto, PermissionCode } from "@erp/contracts";

/**
 * Itens do menu. A visibilidade usa as permissões do `GET /me`: `tenant` = `me.permissions` (cadastros), `branch` =
 * `me.branches[].permissions` da filial da rota. Esconder é só conforto: a API confere de novo e responde 403.
 * Todas as telas ficam sob `/branches/[branchId]/...` (a filial atual é a da rota); `segment` é relativo a ela.
 */
export type NavScope = "branch" | "tenant";

export interface NavItem {
  readonly id: string;
  readonly label: string;
  /** Relativo a `/branches/[branchId]`; `""` = início. */
  readonly segment: string;
  readonly group: "Operação" | "Administração";
  readonly scope: NavScope;
  /** `null` = só autenticação. */
  readonly permission: PermissionCode | null;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "home", label: "Início", segment: "", group: "Operação", scope: "branch", permission: null },
  { id: "orders", label: "Pedidos", segment: "orders", group: "Operação", scope: "branch", permission: "order.read" },
  { id: "cash", label: "Caixa", segment: "cash", group: "Operação", scope: "branch", permission: "cash.read" },
  { id: "menu", label: "Cardápio da filial", segment: "menu", group: "Operação", scope: "branch", permission: "product.read" },
  {
    id: "menu-settings",
    label: "Ajustes do cardápio",
    segment: "menu/settings",
    group: "Operação",
    scope: "branch",
    permission: "product.manage",
  },
  {
    id: "organization",
    label: "Organização",
    segment: "admin/organization",
    group: "Administração",
    scope: "tenant",
    permission: "organization.read",
  },
  { id: "companies", label: "Empresas", segment: "admin/companies", group: "Administração", scope: "tenant", permission: "organization.read" },
  { id: "branches", label: "Filiais", segment: "admin/branches", group: "Administração", scope: "tenant", permission: "branch.read" },
  { id: "users", label: "Usuários", segment: "admin/users", group: "Administração", scope: "tenant", permission: "user.read" },
  { id: "products", label: "Produtos", segment: "admin/products", group: "Administração", scope: "tenant", permission: "product.read" },
];

/** Permissões efetivas no escopo do item; filial sem acesso no `/me` = nenhuma permissão de filial. */
export function canSee(item: NavItem, me: MeDto, branchId: string): boolean {
  if (item.permission === null) return true;
  const granted = item.scope === "tenant" ? me.permissions : (me.branches.find((b) => b.id === branchId)?.permissions ?? []);
  return granted.includes(item.permission);
}

export function visibleNavItems(me: MeDto, branchId: string): NavItem[] {
  return NAV_ITEMS.filter((item) => canSee(item, me, branchId));
}

export function findNavItem(segment: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.segment === segment);
}
