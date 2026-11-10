import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_PERMISSIONS } from "../tenants/default-roles.js";
import { exceedsAuthority, forbiddenRoleChanges, touchesAdministratorWithoutGuard, type RoleChange } from "./authority.js";

const set = (codes: readonly string[]) => new Set(codes);
const { OWNER, MANAGER, ATTENDANT, KITCHEN } = DEFAULT_ROLE_PERMISSIONS;
const B1 = "branch-1";
const B2 = "branch-2";

describe("exceedsAuthority (target rule)", () => {
  it("is false only when every required permission is held by the actor", () => {
    expect(exceedsAuthority(set(OWNER), MANAGER)).toBe(false);
    expect(exceedsAuthority(set(MANAGER), OWNER)).toBe(true); // manager never manages the owner
    expect(exceedsAuthority(set(MANAGER), ATTENDANT)).toBe(false);
    expect(exceedsAuthority(set(MANAGER), KITCHEN)).toBe(false);
    expect(exceedsAuthority(set([]), [])).toBe(false);
    expect(exceedsAuthority(set([]), ["order.read"])).toBe(true);
  });

  it("with the default matrix, equal authority is not above (manager vs manager)", () => {
    expect(exceedsAuthority(set(MANAGER), MANAGER)).toBe(false);
  });
});

describe("forbiddenRoleChanges (roles entering or leaving)", () => {
  const change = (roleId: string, branchId: string | null, permissions: readonly string[]): RoleChange => ({ roleId, branchId, permissions });

  it("checks each change against the actor's permissions in that change's scope", () => {
    const actor = (branchId: string | null) => (branchId === null ? set(MANAGER) : branchId === B1 ? set(MANAGER) : set([]));
    const owner = change("owner", null, OWNER);
    const attendant = change("attendant", null, ATTENDANT);
    const kitchenAtB1 = change("kitchen", B1, KITCHEN);
    const kitchenAtB2 = change("kitchen", B2, KITCHEN); // no permission at B2 (e.g. no access there)
    expect(forbiddenRoleChanges([owner, attendant, kitchenAtB1, kitchenAtB2], actor)).toEqual([owner, kitchenAtB2]);
  });

  it("lets the owner add or remove any default role tenant-wide", () => {
    const changes = Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([code, perms]) => change(code, null, perms));
    expect(forbiddenRoleChanges(changes, () => set(OWNER))).toEqual([]);
  });

  it("a role without permissions is always allowed", () => {
    expect(forbiddenRoleChanges([change("empty", B2, [])], () => set([]))).toEqual([]);
  });
});

describe("touchesAdministratorWithoutGuard (managers do not manage administrators)", () => {
  const owner = new Set(DEFAULT_ROLE_PERMISSIONS.OWNER);
  const manager = new Set(DEFAULT_ROLE_PERMISSIONS.MANAGER);
  it("blocks the manager on anything that carries user.manage", () => {
    expect(touchesAdministratorWithoutGuard(manager, DEFAULT_ROLE_PERMISSIONS.MANAGER)).toBe(true);
    expect(touchesAdministratorWithoutGuard(manager, DEFAULT_ROLE_PERMISSIONS.OWNER)).toBe(true);
  });
  it("lets the manager touch roles and people without user.manage", () => {
    expect(touchesAdministratorWithoutGuard(manager, DEFAULT_ROLE_PERMISSIONS.ATTENDANT)).toBe(false);
    expect(touchesAdministratorWithoutGuard(manager, DEFAULT_ROLE_PERMISSIONS.KITCHEN)).toBe(false);
    expect(touchesAdministratorWithoutGuard(manager, [])).toBe(false);
  });
  it("lets whoever has role.manage (the owner) touch administrators", () => {
    expect(touchesAdministratorWithoutGuard(owner, DEFAULT_ROLE_PERMISSIONS.MANAGER)).toBe(false);
    expect(touchesAdministratorWithoutGuard(owner, DEFAULT_ROLE_PERMISSIONS.OWNER)).toBe(false);
  });
});
