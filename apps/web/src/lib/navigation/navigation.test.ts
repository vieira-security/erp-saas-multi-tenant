import type { BranchSummaryDto } from "@erp/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_BRANCH_ANTIGA, MOCK_BRANCH_CENTRO, MOCK_BRANCH_SHOPPING, mockMe } from "../api/mocks/data";
import {
  branchPath,
  LAST_BRANCH_KEY,
  pickInitialBranch,
  readLastBranch,
  rememberBranch,
  sectionOf,
  switchBranchPath,
} from "./branch-route";
import { canSee, findNavItem, NAV_ITEMS, visibleNavItems } from "./nav-items";

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id);

describe("menu hidden by /me permissions", () => {
  const mixed = mockMe("mixed");

  it("attendant (tenant) without organization/user permissions does not see those admin items", () => {
    const visible = ids(visibleNavItems(mixed, MOCK_BRANCH_CENTRO.id));
    expect(visible).toEqual(["home", "orders", "cash", "menu", "branches", "products"]);
    expect(visible).not.toContain("organization");
    expect(visible).not.toContain("companies");
    expect(visible).not.toContain("users");
  });

  it("branch items follow the permissions of the branch in the route", () => {
    expect(ids(visibleNavItems(mixed, MOCK_BRANCH_CENTRO.id))).not.toContain("menu-settings");
    // MANAGER só na SHOPPING: ganha product.manage lá, mas não muda os itens de tenant
    const shopping = ids(visibleNavItems(mixed, MOCK_BRANCH_SHOPPING.id));
    expect(shopping).toContain("menu-settings");
    expect(shopping).not.toContain("users");
  });

  it("branch without access in /me grants no branch permission", () => {
    expect(ids(visibleNavItems(mixed, "0193a000-0000-7000-8000-00000000ffff"))).toEqual(["home", "branches", "products"]);
  });

  it("owner sees everything", () => {
    expect(visibleNavItems(mockMe("owner"), MOCK_BRANCH_CENTRO.id)).toHaveLength(NAV_ITEMS.length);
  });

  it("canSee / findNavItem", () => {
    const users = findNavItem("admin/users");
    expect(users?.permission).toBe("user.read");
    expect(users && canSee(users, mixed, MOCK_BRANCH_SHOPPING.id)).toBe(false);
    expect(findNavItem("nope")).toBeUndefined();
  });
});

describe("branch in the route", () => {
  const allowAll = () => true;

  it("builds and reads branch paths", () => {
    expect(branchPath("b1")).toBe("/branches/b1");
    expect(branchPath("b1", "admin/companies")).toBe("/branches/b1/admin/companies");
    expect(sectionOf("/branches/b1")).toBe("");
    expect(sectionOf("/branches/b1/")).toBe("");
    expect(sectionOf("/branches/b1/admin/companies")).toBe("admin/companies");
  });

  it("switching branch changes the route and keeps the current screen when allowed", () => {
    expect(switchBranchPath("/branches/a/orders", "b", allowAll)).toBe("/branches/b/orders");
    expect(switchBranchPath("/branches/a", "b", allowAll)).toBe("/branches/b");
  });

  it("falls back to the branch home when the screen is not allowed in the new branch", () => {
    expect(switchBranchPath("/branches/a/menu/settings", "b", (s) => s !== "menu/settings")).toBe("/branches/b");
  });

  it("picks the remembered branch only if still operable, else the first", () => {
    const list: BranchSummaryDto[] = [MOCK_BRANCH_CENTRO, MOCK_BRANCH_SHOPPING];
    expect(pickInitialBranch(list, MOCK_BRANCH_SHOPPING.id)).toBe(MOCK_BRANCH_SHOPPING.id);
    expect(pickInitialBranch(list, MOCK_BRANCH_ANTIGA.id)).toBe(MOCK_BRANCH_CENTRO.id);
    expect(pickInitialBranch(list, null)).toBe(MOCK_BRANCH_CENTRO.id);
    expect(pickInitialBranch([], MOCK_BRANCH_CENTRO.id)).toBeNull();
  });
});

describe("last branch in localStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    const storage = {
      getItem: vi.fn((k: string) => data.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    };
    vi.stubGlobal("localStorage", storage);
    return storage;
  }

  it("remembers only a branch id (UUID)", () => {
    const storage = stubStorage();
    rememberBranch(MOCK_BRANCH_SHOPPING.id);
    rememberBranch("<script>");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(LAST_BRANCH_KEY, MOCK_BRANCH_SHOPPING.id);
    expect(readLastBranch()).toBe(MOCK_BRANCH_SHOPPING.id);
  });

  it("ignores garbage and unavailable storage", () => {
    stubStorage({ [LAST_BRANCH_KEY]: "not-a-uuid" });
    expect(readLastBranch()).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    });
    expect(readLastBranch()).toBeNull();
    expect(() => rememberBranch(MOCK_BRANCH_CENTRO.id)).not.toThrow();
  });
});
