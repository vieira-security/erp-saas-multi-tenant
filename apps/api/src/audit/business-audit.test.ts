import { AUDIT_ACTIONS } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { TenantContextService } from "../tenancy/tenant-context.js";
import { TenantScope } from "../tenancy/tenant-scope.js";
import { AUDIT_ACTION_CATALOG } from "./audit-catalog.js";
import {
  BUSINESS_METADATA_KEYS,
  BusinessAuditWriter,
  UnsafeBusinessAuditMetadataError,
  assertSafeBusinessMetadata,
  toBusinessAuditRow,
  type BusinessAuditAction,
  type BusinessAuditEvent,
} from "./business-audit.js";

const T = "0199a000-0000-7000-8000-00000000000a";
const U = "0199a000-0000-7000-8000-0000000000a1";
const B = "0199a000-0000-7000-8000-0000000000b1";
const R = "0199a000-0000-7000-8000-0000000000c1";
const R2 = "0199a000-0000-7000-8000-0000000000c2";
const D = "0199a000-0000-7000-8000-0000000000d1";

/** One sample of EVERY business action, with the expected row (resource, branch, metadata). */
const SAMPLES: Record<BusinessAuditAction, { event: BusinessAuditEvent; resourceType: string; resourceId: string; branchId: string | null; metadata: unknown }> = {
  "organization.updated": {
    event: { action: "organization.updated", tenantId: T, changes: { name: { from: "A", to: "B" } } },
    resourceType: "organization", resourceId: T, branchId: null, metadata: { changes: { name: { from: "A", to: "B" } } },
  },
  "company.created": {
    event: { action: "company.created", companyId: R, legalName: "L", tradeName: "T", cnpj: "11222333000181", timezone: "America/Sao_Paulo" },
    resourceType: "company", resourceId: R, branchId: null, metadata: { legalName: "L", tradeName: "T", cnpj: "11222333000181", timezone: "America/Sao_Paulo" },
  },
  "company.updated": {
    event: { action: "company.updated", companyId: R, changes: { tradeName: { from: "A", to: "B" } } },
    resourceType: "company", resourceId: R, branchId: null, metadata: { changes: { tradeName: { from: "A", to: "B" } } },
  },
  "company.activated": { event: { action: "company.activated", companyId: R }, resourceType: "company", resourceId: R, branchId: null, metadata: null },
  "company.deactivated": { event: { action: "company.deactivated", companyId: R }, resourceType: "company", resourceId: R, branchId: null, metadata: null },
  "branch.created": {
    event: { action: "branch.created", branchId: B, companyId: R, name: "Loja", code: "LOJA", cnpj: null, timezone: "America/Sao_Paulo" },
    resourceType: "branch", resourceId: B, branchId: B, metadata: { companyId: R, name: "Loja", code: "LOJA", cnpj: null, timezone: "America/Sao_Paulo" },
  },
  "branch.updated": {
    event: { action: "branch.updated", branchId: B, changes: { code: { from: "A", to: "B" } } },
    resourceType: "branch", resourceId: B, branchId: B, metadata: { changes: { code: { from: "A", to: "B" } } },
  },
  "branch.activated": { event: { action: "branch.activated", branchId: B }, resourceType: "branch", resourceId: B, branchId: B, metadata: null },
  "branch.deactivated": { event: { action: "branch.deactivated", branchId: B }, resourceType: "branch", resourceId: B, branchId: B, metadata: null },
  "branch_access.granted": {
    event: { action: "branch_access.granted", branchId: B, targetUserId: R },
    resourceType: "user", resourceId: R, branchId: B, metadata: { targetUserId: R },
  },
  "branch_access.revoked": {
    event: { action: "branch_access.revoked", branchId: B, targetUserId: R },
    resourceType: "user", resourceId: R, branchId: B, metadata: { targetUserId: R },
  },
  "product_category.created": {
    event: { action: "product_category.created", categoryId: R, name: "Lanches", sortOrder: 0 },
    resourceType: "product_category", resourceId: R, branchId: null, metadata: { name: "Lanches", sortOrder: 0 },
  },
  "product_category.updated": {
    event: { action: "product_category.updated", categoryId: R, changes: { sortOrder: { from: 0, to: 1 } } },
    resourceType: "product_category", resourceId: R, branchId: null, metadata: { changes: { sortOrder: { from: 0, to: 1 } } },
  },
  "product_category.activated": { event: { action: "product_category.activated", categoryId: R }, resourceType: "product_category", resourceId: R, branchId: null, metadata: null },
  "product_category.deactivated": { event: { action: "product_category.deactivated", categoryId: R }, resourceType: "product_category", resourceId: R, branchId: null, metadata: null },
  "product.created": {
    event: { action: "product.created", productId: R, name: "X", code: null, categoryId: null, kitchenSectorId: null, basePrice: "25.00", sortOrder: 0, optionGroups: { groups: 1, options: 2 } },
    resourceType: "product", resourceId: R, branchId: null,
    metadata: { name: "X", code: null, categoryId: null, kitchenSectorId: null, basePrice: "25.00", sortOrder: 0, optionGroups: { groups: 1, options: 2 } },
  },
  "product.updated": {
    event: { action: "product.updated", productId: R, changes: { basePrice: { from: "25.00", to: "27.00" } } },
    resourceType: "product", resourceId: R, branchId: null, metadata: { changes: { basePrice: { from: "25.00", to: "27.00" } } },
  },
  "product.option_groups_replaced": {
    event: { action: "product.option_groups_replaced", productId: R, before: { groups: 1, options: 2 }, after: { groups: 0, options: 0 } },
    resourceType: "product", resourceId: R, branchId: null, metadata: { before: { groups: 1, options: 2 }, after: { groups: 0, options: 0 } },
  },
  "product.activated": { event: { action: "product.activated", productId: R }, resourceType: "product", resourceId: R, branchId: null, metadata: null },
  "product.deactivated": { event: { action: "product.deactivated", productId: R }, resourceType: "product", resourceId: R, branchId: null, metadata: null },
  "branch_product_setting.updated": {
    event: { action: "branch_product_setting.updated", branchId: B, productId: R, changes: { price: { from: null, to: "30.00" } } },
    resourceType: "product", resourceId: R, branchId: B, metadata: { changes: { price: { from: null, to: "30.00" } } },
  },
  "cash_session.opened": {
    event: { action: "cash_session.opened", branchId: B, cashSessionId: R, openingAmount: "100.00" },
    resourceType: "cash_session", resourceId: R, branchId: B, metadata: { openingAmount: "100.00" },
  },
  "cash_session.closed": {
    event: { action: "cash_session.closed", branchId: B, cashSessionId: R, expectedCash: "100.00", countedCash: "95.00", difference: "-5.00", justification: "troco" },
    resourceType: "cash_session", resourceId: R, branchId: B, metadata: { expectedCash: "100.00", countedCash: "95.00", difference: "-5.00", justification: "troco" },
  },
  "cash_movement.withdrawal": {
    event: { action: "cash_movement.withdrawal", branchId: B, cashMovementId: R, cashSessionId: R2, amount: "10.00", reason: "cofre" },
    resourceType: "cash_movement", resourceId: R, branchId: B, metadata: { amount: "10.00", reason: "cofre", cashSessionId: R2 },
  },
  "cash_movement.supply": {
    event: { action: "cash_movement.supply", branchId: B, cashMovementId: R, cashSessionId: R2, amount: "10.00", reason: "troco" },
    resourceType: "cash_movement", resourceId: R, branchId: B, metadata: { amount: "10.00", reason: "troco", cashSessionId: R2 },
  },
  "order.cancelled": {
    event: { action: "order.cancelled", branchId: B, orderId: R, number: 7, previousStatus: "CONFIRMED", reason: "erro", refunds: [{ method: "CASH", amount: "25.00" }] },
    resourceType: "order", resourceId: R, branchId: B, metadata: { number: 7, previousStatus: "CONFIRMED", reason: "erro", refunds: [{ method: "CASH", amount: "25.00" }] },
  },
  "kitchen_sector.created": {
    event: { action: "kitchen_sector.created", sectorId: R, name: "Bar", code: "BAR", sortOrder: 1 },
    resourceType: "kitchen_sector", resourceId: R, branchId: null, metadata: { name: "Bar", code: "BAR", sortOrder: 1 },
  },
  "kitchen_sector.updated": {
    event: { action: "kitchen_sector.updated", sectorId: R, changes: { name: { from: "Bar", to: "Bebidas" } } },
    resourceType: "kitchen_sector", resourceId: R, branchId: null, metadata: { changes: { name: { from: "Bar", to: "Bebidas" } } },
  },
  "kitchen_sector.activated": { event: { action: "kitchen_sector.activated", sectorId: R }, resourceType: "kitchen_sector", resourceId: R, branchId: null, metadata: null },
  "kitchen_sector.deactivated": { event: { action: "kitchen_sector.deactivated", sectorId: R }, resourceType: "kitchen_sector", resourceId: R, branchId: null, metadata: null },
  "kitchen_sector.default_changed": {
    event: { action: "kitchen_sector.default_changed", fromSectorId: R2, toSectorId: R },
    resourceType: "kitchen_sector", resourceId: R, branchId: null, metadata: { fromSectorId: R2, toSectorId: R },
  },
  "branch_kitchen_sector.updated": {
    event: { action: "branch_kitchen_sector.updated", branchId: B, sectorId: R, changes: { enabled: { from: true, to: false } } },
    resourceType: "kitchen_sector", resourceId: R, branchId: B, metadata: { changes: { enabled: { from: true, to: false } } },
  },
  "kitchen_ticket.reprinted": {
    event: { action: "kitchen_ticket.reprinted", branchId: B, ticketId: R, orderId: R2, sectorId: D, copyNumber: 2 },
    resourceType: "kitchen_ticket", resourceId: R, branchId: B, metadata: { copyNumber: 2, orderId: R2, sectorId: D },
  },
};

function writer() {
  const rows: Record<string, unknown>[] = [];
  const tenants = new TenantContextService();
  const db = { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void rows.push(data) } };
  const audit = new BusinessAuditWriter(db as never, new TenantScope(tenants));
  return {
    rows,
    record: (event: BusinessAuditEvent, actor: { userId: string; deviceId: string | null } | null = { userId: U, deviceId: D }) =>
      tenants.run({ tenantId: T }, () => audit.record(actor, event)),
  };
}

describe("audit action catalog", () => {
  it("mirrors AUDIT_ACTIONS of the contract (same values, same order)", () => {
    expect([...AUDIT_ACTION_CATALOG]).toEqual([...AUDIT_ACTIONS]);
  });

  it("every business action has a sample here and an allowlist entry (and nothing else)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(BUSINESS_METADATA_KEYS).sort());
    for (const action of Object.keys(SAMPLES)) expect(AUDIT_ACTION_CATALOG as readonly string[], action).toContain(action);
  });
});

describe("business audit rows (one format per action)", () => {
  for (const [action, sample] of Object.entries(SAMPLES)) {
    it(`${action}: resource, branch and metadata`, () => {
      const row = toBusinessAuditRow(sample.event);
      expect(row).toEqual({ resourceType: sample.resourceType, resourceId: sample.resourceId, branchId: sample.branchId, metadata: sample.metadata });
      expect(Object.keys(row.metadata ?? {}).sort(), action).toEqual([...BUSINESS_METADATA_KEYS[action as BusinessAuditAction]].sort());
      expect(() => assertSafeBusinessMetadata(sample.event.action, row.metadata)).not.toThrow();
    });
  }
});

describe("BusinessAuditWriter", () => {
  it("writes the actor in user_id (and its device), the branch, the resource and the metadata, in the current tenant", async () => {
    const { rows, record } = writer();
    expect(await record(SAMPLES["cash_session.opened"].event)).toBe(true);
    expect(rows).toEqual([
      {
        tenantId: T,
        action: "cash_session.opened",
        resourceType: "cash_session",
        resourceId: R,
        branchId: B,
        userId: U,
        deviceId: D,
        metadata: { openingAmount: "100.00" },
      },
    ]);
  });

  it("records the system (no authenticated request) as user_id null", async () => {
    const { rows, record } = writer();
    await record(SAMPLES["product.activated"].event, null);
    expect(rows[0]).toMatchObject({ userId: null, deviceId: null, action: "product.activated" });
    expect(rows[0]).not.toHaveProperty("metadata");
  });

  it("does not write an update whose `changes` is empty (idempotent operation without change)", async () => {
    const { rows, record } = writer();
    for (const event of [
      { action: "product.updated", productId: R, changes: {} },
      { action: "branch_product_setting.updated", branchId: B, productId: R, changes: {} },
      { action: "branch_kitchen_sector.updated", branchId: B, sectorId: R, changes: {} },
      { action: "organization.updated", tenantId: T, changes: {} },
    ] satisfies BusinessAuditEvent[]) {
      expect(await record(event), event.action).toBe(false);
    }
    expect(rows).toEqual([]);
  });

  it("fails closed (and writes nothing) on metadata with a secret-looking key, at any depth", async () => {
    const { rows, record } = writer();
    const leaked = { action: "product.updated", productId: R, changes: { passwordHash: { from: "a", to: "b" } } } as unknown as BusinessAuditEvent;
    await expect(record(leaked)).rejects.toThrow(UnsafeBusinessAuditMetadataError);
    expect(rows).toEqual([]);
  });
});

describe("assertSafeBusinessMetadata", () => {
  it("rejects keys outside the action allowlist, secret-looking keys, deep or non-JSON values and oversized text", () => {
    expect(() => assertSafeBusinessMetadata("cash_session.opened", { openingAmount: "1.00", password: "x" })).toThrow(UnsafeBusinessAuditMetadataError);
    expect(() => assertSafeBusinessMetadata("cash_session.opened", { openingAmount: "1.00", extra: 1 })).toThrow(UnsafeBusinessAuditMetadataError);
    expect(() => assertSafeBusinessMetadata("company.activated", { anything: 1 })).toThrow(UnsafeBusinessAuditMetadataError);
    expect(() => assertSafeBusinessMetadata("cash_session.opened", null)).toThrow(UnsafeBusinessAuditMetadataError);
    for (const key of ["token", "refreshToken", "senha", "cardNumber", "cvv", "secret", "apiKey", "pin"]) {
      expect(() => assertSafeBusinessMetadata("product.updated", { changes: { [key]: { from: 1, to: 2 } } }), key).toThrow(UnsafeBusinessAuditMetadataError);
    }
    expect(() => assertSafeBusinessMetadata("cash_movement.supply", { amount: "1.00", reason: "x".repeat(1001), cashSessionId: R })).toThrow(
      UnsafeBusinessAuditMetadataError,
    );
    expect(() =>
      assertSafeBusinessMetadata("product.updated", { changes: { name: { from: { a: { b: { c: 1 } } }, to: 1 } } } as never),
    ).toThrow(UnsafeBusinessAuditMetadataError);
    expect(() => assertSafeBusinessMetadata("cash_session.opened", { openingAmount: new Date() as never })).toThrow(UnsafeBusinessAuditMetadataError);
  });
});
