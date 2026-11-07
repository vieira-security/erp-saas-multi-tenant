import { describe, expect, it } from "vitest";
import { buildMenu, compareOrdered, type MenuSourceGroup, type MenuSourceProduct } from "./menu.js";

const T0 = new Date("2026-11-07T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function product(id: string, extra: Partial<MenuSourceProduct> = {}): MenuSourceProduct {
  return { id, categoryId: null, name: id, description: null, code: null, basePrice: "10.00", sortOrder: 0, createdAt: T0, optionGroups: [], ...extra };
}

function group(id: string, extra: Partial<MenuSourceGroup> = {}): MenuSourceGroup {
  return { id, name: id, minChoices: 0, maxChoices: 1, sortOrder: 0, createdAt: T0, options: [], ...extra };
}

const opt = (id: string, sortOrder: number, linkedProductId: string | null = null, priceDelta = "0.00") => ({
  id,
  name: id,
  priceDelta,
  linkedProductId,
  sortOrder,
  createdAt: T0,
});

describe("buildMenu", () => {
  it("lists only available products with the effective price (branch override or base)", () => {
    const menu = buildMenu({
      branchId: "b",
      categories: [],
      products: [product("p1"), product("p2", { basePrice: "8.00" }), product("p3")],
      settings: [
        { productId: "p2", available: true, price: "9.50" },
        { productId: "p3", available: false, price: null },
      ],
    });
    expect(menu.branchId).toBe("b");
    expect(menu.products.map((p) => [p.id, p.price])).toEqual([
      ["p1", "10.00"],
      ["p2", "9.50"],
    ]);
  });

  it("keeps only active categories with at least one product; inactive category products show no category", () => {
    const menu = buildMenu({
      branchId: "b",
      categories: [
        { id: "drinks", name: "Bebidas", sortOrder: 2, createdAt: T0 },
        { id: "food", name: "Lanches", sortOrder: 1, createdAt: T0 },
        { id: "empty", name: "Vazia", sortOrder: 0, createdAt: T0 },
      ],
      products: [
        product("burger", { categoryId: "food" }),
        product("juice", { categoryId: "drinks" }),
        product("old", { categoryId: "inactive-category" }),
        product("hidden", { categoryId: "empty" }),
      ],
      settings: [{ productId: "hidden", available: false, price: null }],
    });
    expect(menu.categories).toEqual([
      { id: "food", name: "Lanches", sortOrder: 1 },
      { id: "drinks", name: "Bebidas", sortOrder: 2 },
    ]);
    expect(menu.products.map((p) => [p.id, p.categoryId])).toEqual([
      ["burger", "food"],
      ["juice", "drinks"],
      ["old", null],
    ]);
  });

  it("filters combo options whose linked product is inactive (absent) or unavailable in the branch", () => {
    const combo = product("combo", {
      optionGroups: [group("drink", { minChoices: 1, maxChoices: 1, options: [opt("coke", 0, "coke-p"), opt("juice", 1, "juice-p"), opt("tea", 2, "tea-p")] })],
    });
    const menu = buildMenu({
      branchId: "b",
      categories: [],
      // "tea-p" is not in the list: it is INACTIVE (the service only loads ACTIVE products).
      products: [combo, product("coke-p"), product("juice-p")],
      settings: [{ productId: "juice-p", available: false, price: null }],
    });
    expect(menu.products.find((p) => p.id === "combo")?.optionGroups[0]?.options.map((o) => o.id)).toEqual(["coke"]);
    // Same sortOrder and createdAt: tie broken by id ("coke-p" < "combo").
    expect(menu.products.map((p) => p.id)).toEqual(["coke-p", "combo"]);
  });

  it("omits a product whose required group ends up below minChoices", () => {
    const combo = product("combo", {
      optionGroups: [group("drink", { minChoices: 1, maxChoices: 1, options: [opt("coke", 0, "coke-p")] })],
    });
    const menu = buildMenu({ branchId: "b", categories: [], products: [combo, product("coke-p")], settings: [{ productId: "coke-p", available: false, price: null }] });
    expect(menu.products).toEqual([]);
  });

  it("drops an optional group left without options and caps maxChoices at the remaining options", () => {
    const p = product("p", {
      optionGroups: [
        group("extras", { minChoices: 0, maxChoices: 3, options: [opt("bacon", 0), opt("x", 1, "gone"), opt("y", 2, "gone")] }),
        group("side", { sortOrder: 1, minChoices: 0, maxChoices: 1, options: [opt("fries", 0, "gone")] }),
      ],
    });
    const menu = buildMenu({ branchId: "b", categories: [], products: [p], settings: [] });
    expect(menu.products[0]?.optionGroups).toEqual([
      { id: "extras", name: "extras", minChoices: 0, maxChoices: 1, sortOrder: 0, options: [{ id: "bacon", name: "bacon", priceDelta: "0.00", linkedProductId: null, sortOrder: 0 }] },
    ]);
  });

  it("orders products, categories, groups and options by sortOrder, then creation, then id — never by text", () => {
    const menu = buildMenu({
      branchId: "b",
      categories: [],
      products: [
        product("c", { sortOrder: 1, createdAt: at(0) }),
        product("b", { sortOrder: 0, createdAt: at(5) }),
        product("Z", { sortOrder: 0, createdAt: at(1) }),
        product("a2", { sortOrder: 0, createdAt: at(1) }),
        product("g", {
          sortOrder: 2,
          optionGroups: [
            group("g2", { sortOrder: 1, options: [opt("o1", 0)] }),
            group("g1", { sortOrder: 0, options: [opt("o3", 2), opt("o1", 0), opt("o2", 1)] }),
          ],
        }),
      ],
      settings: [],
    });
    // Same sortOrder and createdAt: "Z" < "a2" by code unit (a locale collation would put "a2" first).
    expect(menu.products.map((p) => p.id)).toEqual(["Z", "a2", "b", "c", "g"]);
    const g = menu.products.at(-1)!;
    expect(g.optionGroups.map((x) => x.id)).toEqual(["g1", "g2"]);
    expect(g.optionGroups[0]?.options.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
  });

  it("does not mutate its input", () => {
    const products = [product("b", { sortOrder: 1 }), product("a", { sortOrder: 0 })];
    buildMenu({ branchId: "b", categories: [], products, settings: [] });
    expect(products.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("compareOrdered is a total order", () => {
    const x = { id: "x", sortOrder: 0, createdAt: T0 };
    expect(compareOrdered(x, { ...x })).toBe(0);
    expect(compareOrdered(x, { ...x, id: "y" })).toBeLessThan(0);
    expect(compareOrdered({ ...x, createdAt: at(1) }, x)).toBeGreaterThan(0);
  });
});
