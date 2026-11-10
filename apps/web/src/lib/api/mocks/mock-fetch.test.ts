import { PERMISSION_CODES, type MeDto } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { createErpApi } from "../endpoints";
import { ApiError } from "../errors";
import { createHttpClient } from "../http-client";
import { MOCK_BRANCHES, mockMe } from "./data";
import { createMockFetch, paginate } from "./mock-fetch";

async function setup(options: Parameters<typeof createMockFetch>[0] = {}) {
  const client = createHttpClient({ fetch: createMockFetch(options) });
  const api = createErpApi(client);
  return { client, api, refresh: await client.refresh() };
}

describe("mock API (typed by @erp/contracts)", () => {
  it("bootstraps the session through /auth/refresh and serves /me", async () => {
    const { api, refresh } = await setup();
    expect(refresh.ok).toBe(true);
    const me = await api.me();
    expect(me.user.name).toBe("Ana Souza");
    expect(me.organization.loginCode).toBe("DEMO");
  });

  it("/me/branches lists only operable branches, short form", async () => {
    const { api } = await setup();
    const me = await api.me();
    const branches = await api.myBranches();
    expect(branches.map((b) => b.code)).toEqual(["CENTRO", "SHOPPING", "QUIOSQUE-01"]);
    expect(me.branches.find((b) => b.code === "ANTIGA")?.operable).toBe(false);
    expect(Object.keys(branches[0] ?? {}).sort()).toEqual(["code", "companyId", "id", "name", "status"]);
  });

  it("paginates /branches as the contract (default 20, max 100)", async () => {
    const { api } = await setup();
    const first = await api.branches();
    expect(first).toMatchObject({ page: 1, pageSize: 20, total: 25, totalPages: 2 });
    expect(first.items).toHaveLength(20);
    const second = await api.branches({ page: 2 });
    expect(second.items).toHaveLength(5);
    const inactive = await api.branches({ status: "INACTIVE" });
    expect(inactive.items.map((b) => b.code)).toEqual(["ANTIGA"]);
    expect((await api.branches({ pageSize: 100 })).items).toHaveLength(25);
  });

  it("rejects invalid paging like the API", async () => {
    const { api } = await setup();
    const error = await api.branches({ pageSize: 101 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: [{ field: "pageSize", issue: "invalid_value" }] });
  });

  it("enforces tenant permissions (attendant has no organization.read)", async () => {
    const { api } = await setup();
    await expect(api.companies()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(api.organization()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("owner profile reads organization and companies", async () => {
    const { api } = await setup({ profile: "owner" });
    expect((await api.organization()).name).toBe("Restaurante Demo");
    const companies = await api.companies({ status: "ACTIVE" });
    expect(companies).toMatchObject({ total: 2, totalPages: 1 });
  });

  it("expired session: refresh fails and business routes answer 401", async () => {
    const { api, refresh } = await setup({ session: "expired" });
    expect(refresh.ok).toBe(false);
    await expect(api.me()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("logout ends the mock session", async () => {
    const { client, api } = await setup();
    await client.logout();
    expect((await client.refresh()).ok).toBe(false);
    await expect(api.me()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("mock data never carries a tenant id and permissions are in the catalog, sorted", () => {
    for (const profile of ["mixed", "owner"] as const) {
      const me: MeDto = mockMe(profile);
      expect(JSON.stringify(me)).not.toMatch(/tenant/i);
      for (const list of [me.permissions, ...me.branches.map((b) => b.permissions)]) {
        expect(list.every((p) => PERMISSION_CODES.includes(p))).toBe(true);
        expect([...list].sort()).toEqual(list);
      }
    }
    expect(JSON.stringify(MOCK_BRANCHES)).not.toMatch(/tenant/i);
  });

  it("paginate computes totals", () => {
    expect(paginate([1, 2, 3], 2, 2)).toEqual({ items: [3], page: 2, pageSize: 2, total: 3, totalPages: 2 });
  });
});
