import { expect } from "vitest";

/** SQLSTATE raised by forbid_tenant_id_change() (integrity_constraint_violation). */
export const TENANT_ID_IMMUTABLE_SQLSTATE = "23000";

interface DriverCause {
  originalCode?: string;
  column?: string;
  originalMessage?: string;
}

/**
 * Asserts that `action` was rejected by the tenant_id immutability trigger of `table`, judged by SQLSTATE,
 * error column and table (not by the full message text). Works for Prisma model calls and raw SQL alike.
 */
export async function expectTenantIdImmutable(action: Promise<unknown>, table: string): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught, `tenant_id change on ${table} should be rejected`).toBeDefined();
  const cause = (caught as { meta?: { driverAdapterError?: { cause?: DriverCause } } }).meta?.driverAdapterError?.cause;
  expect(cause, String(caught)).toMatchObject({ originalCode: TENANT_ID_IMMUTABLE_SQLSTATE, column: "tenant_id" });
  expect(cause?.originalMessage).toContain(`public.${table} `);
}
