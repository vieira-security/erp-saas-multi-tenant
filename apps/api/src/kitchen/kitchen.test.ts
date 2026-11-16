import * as contract from "@erp/contracts";
import type { KitchenTicketStatus } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { ValidationFailedError } from "../http/api-error.js";
import { parseInput, required } from "../http/input.js";
import { DEFAULT_KITCHEN_SECTOR } from "../tenants/default-roles.js";
import {
  DefaultKitchenSectorMissingError,
  compareSectors,
  deriveOrderStatus,
  effectiveSector,
  nextTicketStatus,
  orderStatusSteps,
  receivesTickets,
  routeItems,
  shortcutTargets,
  type RoutableSector,
} from "./kitchen-rules.js";
import { CANCELLED_BANNER, CUT_LINE, PRINT_WIDTH, localDateTime, ticketLines, wrap, type PrintableTicket } from "./print-layout.js";
import * as api from "./validation.js";
import { sectorCode, ticketStatusList } from "./validation.js";

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.details;
    throw error;
  }
  throw new Error("expected ValidationFailedError");
}

const sector = (id: string, extra: Partial<RoutableSector> = {}): RoutableSector => ({
  id,
  name: id,
  code: id.toUpperCase(),
  isDefault: false,
  status: "ACTIVE",
  enabledInBranch: true,
  ...extra,
});

const KITCHEN = sector("cozinha", { isDefault: true });
const BAR = sector("bar");
const GRILL_OFF = sector("chapa", { enabledInBranch: false });
const DESSERT_INACTIVE = sector("doces", { status: "INACTIVE" });
const SECTORS = [BAR, KITCHEN, GRILL_OFF, DESSERT_INACTIVE];

describe("M7 constants", () => {
  it("match the values published in @erp/contracts", () => {
    expect(api.KITCHEN_SECTOR_STATUSES).toEqual(contract.KITCHEN_SECTOR_STATUSES);
    expect(api.KITCHEN_TICKET_STATUSES).toEqual(contract.KITCHEN_TICKET_STATUSES);
  });

  it("the default sector is the documented one ('Cozinha', COZINHA) and passes the sector code rule", () => {
    expect(DEFAULT_KITCHEN_SECTOR).toEqual({ name: "Cozinha", code: "COZINHA" });
    expect(sectorCode(DEFAULT_KITCHEN_SECTOR.code)).toEqual({ ok: true, value: "COZINHA" });
  });
});

describe("effective sector of an item", () => {
  it("is the product's sector when it receives tickets in the branch", () => {
    expect(effectiveSector("bar", SECTORS)).toBe(BAR);
    expect(effectiveSector("cozinha", SECTORS)).toBe(KITCHEN);
  });

  it("falls back to the default: product without sector, INACTIVE sector, sector off in the branch, unknown sector", () => {
    expect(effectiveSector(null, SECTORS)).toBe(KITCHEN);
    expect(effectiveSector("doces", SECTORS)).toBe(KITCHEN);
    expect(effectiveSector("chapa", SECTORS)).toBe(KITCHEN);
    expect(effectiveSector("sumiu", SECTORS)).toBe(KITCHEN);
  });

  it("the default always receives tickets, even with a stale 'off' setting in the branch", () => {
    const stale = sector("cozinha", { isDefault: true, enabledInBranch: false });
    expect(receivesTickets(stale)).toBe(true);
    expect(effectiveSector(null, [stale, BAR])).toBe(stale);
    expect(receivesTickets(GRILL_OFF)).toBe(false);
    expect(receivesTickets(DESSERT_INACTIVE)).toBe(false);
    expect(receivesTickets(sector("x", { status: "INACTIVE", enabledInBranch: false }))).toBe(false);
  });

  it("fails closed when the tenant has no default sector", () => {
    expect(() => effectiveSector("bar", [BAR])).toThrow(DefaultKitchenSectorMissingError);
  });
});

describe("routing the items of an order into tickets", () => {
  it("creates one ticket per effective sector, with only its items, in the order of the first item", () => {
    expect(
      routeItems(
        [
          { orderItemId: "i1", productSectorId: "bar" },
          { orderItemId: "i2", productSectorId: null },
          { orderItemId: "i3", productSectorId: "chapa" }, // off in the branch -> default
          { orderItemId: "i4", productSectorId: "bar" },
        ],
        SECTORS,
      ),
    ).toEqual([
      { sector: BAR, orderItemIds: ["i1", "i4"] },
      { sector: KITCHEN, orderItemIds: ["i2", "i3"] },
    ]);
    expect(routeItems([], SECTORS)).toEqual([]);
  });

  it("a combo goes whole to the main product's sector (only the main product's sector is an input)", () => {
    // The combo item carries the main product's sector; the linked drink (bar) never splits it.
    expect(routeItems([{ orderItemId: "combo", productSectorId: null }], SECTORS)).toEqual([{ sector: KITCHEN, orderItemIds: ["combo"] }]);
  });
});

describe("ticket flow", () => {
  it("WAITING -start-> PREPARING -ready-> READY; anything else is invalid", () => {
    expect(nextTicketStatus("WAITING", "start")).toBe("PREPARING");
    expect(nextTicketStatus("PREPARING", "ready")).toBe("READY");
    for (const [from, action] of [
      ["WAITING", "ready"],
      ["PREPARING", "start"],
      ["READY", "start"],
      ["READY", "ready"],
      ["CANCELLED", "start"],
      ["CANCELLED", "ready"],
    ] as const) {
      expect(nextTicketStatus(from, action), `${from} ${action}`).toBeNull();
    }
  });

  it("the order shortcut moves WAITING tickets on start and every open ticket on ready", () => {
    const tickets = (["WAITING", "PREPARING", "READY", "WAITING"] as const).map((status, i) => ({ id: `t${i}`, status }));
    expect(shortcutTargets(tickets, "start").map((t) => t.id)).toEqual(["t0", "t3"]);
    expect(shortcutTargets(tickets, "ready").map((t) => t.id)).toEqual(["t0", "t1", "t3"]);
    expect(shortcutTargets([{ status: "READY" as const }], "ready")).toEqual([]);
    expect(shortcutTargets([{ status: "CANCELLED" as const }], "start")).toEqual([]);
  });
});

describe("order status derived from its tickets", () => {
  const derive = (...statuses: KitchenTicketStatus[]) => deriveOrderStatus(statuses);

  it("all WAITING = CONFIRMED; all READY = READY; any PREPARING or part READY = PREPARING", () => {
    expect(derive("WAITING")).toBe("CONFIRMED");
    expect(derive("WAITING", "WAITING")).toBe("CONFIRMED");
    expect(derive("PREPARING", "WAITING")).toBe("PREPARING");
    expect(derive("READY", "WAITING")).toBe("PREPARING");
    expect(derive("READY", "PREPARING")).toBe("PREPARING");
    expect(derive("READY")).toBe("READY");
    expect(derive("READY", "READY")).toBe("READY");
  });

  it("ignores cancelled tickets and has nothing to derive without open tickets", () => {
    expect(derive()).toBeNull();
    expect(derive("CANCELLED", "CANCELLED")).toBeNull();
  });

  it("reaches the derived status one M5 arrow at a time, never backwards", () => {
    expect(orderStatusSteps("CONFIRMED", "PREPARING")).toEqual(["PREPARING"]);
    expect(orderStatusSteps("CONFIRMED", "READY")).toEqual(["PREPARING", "READY"]);
    expect(orderStatusSteps("PREPARING", "READY")).toEqual(["READY"]);
    expect(orderStatusSteps("PREPARING", "PREPARING")).toEqual([]);
    expect(orderStatusSteps("READY", "PREPARING")).toEqual([]);
    expect(orderStatusSteps("CANCELLED", "READY")).toEqual([]);
    expect(orderStatusSteps("DELIVERED", "READY")).toEqual([]);
  });
});

describe("sector display order", () => {
  it("default first, then sortOrder, then name by code point, then id", () => {
    const rows = [
      { id: "4", isDefault: false, sortOrder: 1, name: "bar" },
      { id: "3", isDefault: false, sortOrder: 1, name: "Bar" },
      { id: "2", isDefault: false, sortOrder: 0, name: "Zeta" },
      { id: "1", isDefault: true, sortOrder: 9, name: "Cozinha" },
      { id: "0", isDefault: false, sortOrder: 1, name: "Bar" },
    ];
    expect([...rows].sort(compareSectors).map((r) => r.id)).toEqual(["1", "2", "0", "3", "4"]);
  });
});

describe("kitchen parsers", () => {
  const parseStatus = (status: unknown) => parseInput({ status }, { status: required(ticketStatusList) }, "query").status;

  it("status: CSV of valid ticket statuses, duplicates ignored", () => {
    expect(parseStatus("WAITING,PREPARING,WAITING")).toEqual(["WAITING", "PREPARING"]);
    expect(parseStatus("CANCELLED")).toEqual(["CANCELLED"]);
    for (const bad of ["", "WAITING,", "waiting", "EDITING", "WAITING,,READY"]) {
      expect(issuesOf(() => parseStatus(bad)), bad).toEqual([{ field: "status", issue: "invalid_value" }]);
    }
  });

  it("sector code: trimmed and upper-cased, products.code format", () => {
    expect(sectorCode(" bar-1 ")).toEqual({ ok: true, value: "BAR-1" });
    expect(sectorCode("")).toEqual({ ok: false, issue: "too_short" });
    expect(sectorCode("x".repeat(33))).toEqual({ ok: false, issue: "too_long" });
    expect(sectorCode("-BAR")).toEqual({ ok: false, issue: "invalid_format" });
    expect(sectorCode("ÇOZINHA")).toEqual({ ok: false, issue: "invalid_format" });
    expect(sectorCode(7)).toEqual({ ok: false, issue: "invalid_type" });
  });
});

describe("print layout (80 mm, 48 columns)", () => {
  const base: PrintableTicket = {
    sectorName: "Cozinha",
    orderNumber: 12,
    createdAt: new Date("2026-11-10T17:35:00Z"),
    timeZone: "America/Sao_Paulo",
    status: "WAITING",
    copyNumber: 1,
    items: [
      { quantity: 2, productName: "X-Burger", options: [{ groupName: "Tamanho", name: "G" }, { groupName: "Extras", name: "Bacon" }], note: "sem cebola" },
      { quantity: 1, productName: "Combo", options: [{ groupName: "Bebida", name: "Refri" }], note: null },
    ],
  };
  const fits = (lines: readonly string[]) => lines.every((l) => [...l].length <= PRINT_WIDTH);

  it("prints sector, order number, local date/time, quantity x product, indented options, note and the cut line", () => {
    expect(ticketLines(base)).toEqual([
      "                    COZINHA",
      "                   PEDIDO #12",
      "10/11/2026 14:35",
      "=".repeat(48),
      "2x X-Burger",
      "   Tamanho: G",
      "   Extras: Bacon",
      "   OBS: sem cebola",
      "1x Combo",
      "   Bebida: Refri",
      "=".repeat(48),
      CUT_LINE,
    ]);
    expect([...CUT_LINE].length).toBeLessThanOrEqual(PRINT_WIDTH);
  });

  it("never prints prices or money", () => {
    expect(ticketLines(base).join("\n")).not.toMatch(/R\$|[0-9]+[.,][0-9]{2}\b/);
  });

  it("uses the branch time zone (the business day can differ from UTC)", () => {
    const late = new Date("2026-11-10T02:30:00Z");
    expect(localDateTime(late, "America/Sao_Paulo")).toBe("09/11/2026 23:30");
    expect(localDateTime(late, "UTC")).toBe("10/11/2026 02:30");
    expect(localDateTime(late, "America/Manaus")).toBe("09/11/2026 22:30");
    expect(ticketLines({ ...base, createdAt: late })[2]).toBe("09/11/2026 23:30");
  });

  it("adds the numbered copy ('2ª VIA', '7ª VIA') from the second copy and '*** CANCELADO ***' for a cancelled ticket", () => {
    const second = ticketLines({ ...base, copyNumber: 2 });
    expect(second[0]!.trim()).toBe("2ª VIA");
    expect(ticketLines({ ...base, copyNumber: 7 })[0]!.trim()).toBe("7ª VIA");
    const cancelled = ticketLines({ ...base, status: "CANCELLED", copyNumber: 3 });
    expect(cancelled.slice(0, 2).map((l) => l.trim())).toEqual([CANCELLED_BANNER, "3ª VIA"]);
    expect(ticketLines({ ...base, status: "CANCELLED" })[0]!.trim()).toBe("*** CANCELADO ***");
    expect(ticketLines(base).some((l) => l.includes("VIA") || l.includes("CANCELADO"))).toBe(false);
  });

  it("wraps long words and lines without passing 48 columns, keeping accents and indentation", () => {
    const longName = "Hambúrguer artesanal de costela defumada com cebola caramelizada e maionese de alho assado";
    const note = "Pão sem gergelim, ponto da carne mal passado, trocar batata por salada e não colocar picles";
    const lines = ticketLines({
      ...base,
      sectorName: "Setor de sobremesas e confeitaria especial da casa (térreo)",
      items: [{ quantity: 99, productName: longName, options: [{ groupName: "Adicionais", name: "Queijo coalho grelhado".repeat(3) }], note }],
    });
    expect(fits(lines)).toBe(true);
    expect(lines.join(" ")).toContain("Hambúrguer");
    expect(lines.join(" ")).toContain("não");
    const item = lines.findIndex((l) => l.startsWith("99x "));
    expect(lines[item + 1]!.startsWith("    ")).toBe(true); // continuation aligned under the product name
    expect(lines.filter((l) => l.startsWith("   OBS: "))).toHaveLength(1);

    expect(wrap("x".repeat(100))).toEqual(["x".repeat(48), "x".repeat(48), "xxxx"]);
    expect(wrap("ção".repeat(20), "   ").every((l) => [...l].length <= 48)).toBe(true);
    expect(wrap("palavra   com\nquebra\te   tab")).toEqual(["palavra com quebra e tab"]);
    expect(wrap("")).toEqual([""]);
  });

  it("counts accents as one column (NFC), even when they arrive decomposed", () => {
    const decomposed = "Pão".normalize("NFD");
    const [line] = wrap(decomposed.repeat(16));
    expect([...line!].length).toBe(48);
    expect(line).toBe("Pão".repeat(16));
  });
});
