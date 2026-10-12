import { randomBytes } from "node:crypto";
import {
  BranchStatus,
  CompanyStatus,
  DeviceStatus,
  DeviceType,
  TenantStatus,
  UserStatus,
  type PrismaClient,
} from "../../src/generated/prisma/client.js";
import { AuthService } from "../../src/auth/auth.service.js";
import { AuthContextService } from "../../src/auth/context/auth-context.js";
import { PasswordHasher } from "../../src/auth/password/password-hasher.js";
import { AccessTokenService } from "../../src/auth/tokens/access-token.service.js";
import { AUTH_ENV, loadAuthConfig, type AuthConfig } from "../../src/config/auth-config.js";
import { TenantContextService } from "../../src/tenancy/tenant-context.js";
import { TenantScope } from "../../src/tenancy/tenant-scope.js";

/** Test-only secret, random per run: never a fixed value, never the production one. */
export function testAuthConfig(overrides: Record<string, string> = {}): AuthConfig {
  return loadAuthConfig({ [AUTH_ENV.secret]: randomBytes(48).toString("base64url"), ...overrides });
}

/** Auth wired by hand (no Nest) on the runtime identity, so every query runs with erp_app's grants. */
export interface AuthHarness {
  readonly config: AuthConfig;
  readonly tenants: TenantContextService;
  readonly scope: TenantScope;
  readonly authContext: AuthContextService;
  readonly hasher: PasswordHasher;
  readonly accessTokens: AccessTokenService;
  readonly auth: AuthService;
}

export function authHarness(app: PrismaClient, config: AuthConfig = testAuthConfig()): AuthHarness {
  const tenants = new TenantContextService();
  const scope = new TenantScope(tenants);
  const hasher = new PasswordHasher();
  const accessTokens = new AccessTokenService(config);
  return {
    config,
    tenants,
    scope,
    authContext: new AuthContextService(tenants),
    hasher,
    accessTokens,
    auth: new AuthService(app, tenants, scope, hasher, accessTokens, config),
  };
}

export interface Org {
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly otherBranchId: string;
}

/** Tenant + company + two branches, created with the owner identity (fixtures are not the code under test). */
export async function seedOrg(owner: PrismaClient, name = "Auth", status: TenantStatus = TenantStatus.ACTIVE): Promise<Org> {
  const tenant = await owner.tenant.create({ data: { name, status } });
  const company = await owner.company.create({
    data: { tenantId: tenant.id, legalName: `${name} Ltda`, tradeName: name, cnpj: "11222333000181", status: CompanyStatus.ACTIVE, timezone: "America/Sao_Paulo" },
  });
  const branch = (code: string) =>
    owner.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: code, code, status: BranchStatus.ACTIVE, timezone: "America/Sao_Paulo" },
    });
  const [main, other] = [await branch("MAIN"), await branch("OTHER")];
  return { tenantId: tenant.id, companyId: company.id, branchId: main.id, otherBranchId: other.id };
}

const hashes = new Map<string, Promise<string>>();
const fixtureHasher = new PasswordHasher();

/** One Argon2id hash per distinct password per run (hashing is deliberately slow). */
export function hashFor(password: string): Promise<string> {
  let hash = hashes.get(password);
  if (!hash) {
    hash = fixtureHasher.hash(password);
    hashes.set(password, hash);
  }
  return hash;
}

export interface SeedUser {
  employeeNumber?: string;
  password?: string;
  passwordHash?: string;
  status?: UserStatus;
  mustChangePassword?: boolean;
}

export const DEFAULT_PASSWORD = "Senha-Correta-123";

export async function seedUser(owner: PrismaClient, tenantId: string, input: SeedUser = {}): Promise<{ id: string; employeeNumber: string }> {
  const employeeNumber = input.employeeNumber ?? `E${randomBytes(4).toString("hex")}`;
  const user = await owner.user.create({
    data: {
      tenantId,
      name: `User ${employeeNumber}`,
      employeeNumber,
      passwordHash: input.passwordHash ?? (await hashFor(input.password ?? DEFAULT_PASSWORD)),
      status: input.status ?? UserStatus.ACTIVE,
      mustChangePassword: input.mustChangePassword ?? false,
      ...(input.status === UserStatus.DISABLED ? { disabledAt: new Date() } : {}),
    },
  });
  return { id: user.id, employeeNumber };
}

export async function seedDevice(
  owner: PrismaClient,
  tenantId: string,
  input: { status?: DeviceStatus; branchId?: string; deviceKey?: string } = {},
): Promise<{ id: string; deviceKey: string }> {
  const deviceKey = input.deviceKey ?? `POS-${randomBytes(4).toString("hex")}`;
  const device = await owner.device.create({
    data: {
      tenantId,
      branchId: input.branchId ?? null,
      name: deviceKey,
      deviceType: DeviceType.POS,
      deviceKey,
      status: input.status ?? DeviceStatus.ACTIVE,
    },
  });
  return { id: device.id, deviceKey };
}

/** Moves a session into the past (keeps the `expires_at > created_at` CHECK satisfied). */
export async function expireSession(owner: PrismaClient, sessionId: string): Promise<void> {
  await owner.$executeRaw`UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = ${sessionId}::uuid`;
}

/** Every credential-like value that must never reach the database in clear text. */
export function containsSecret(haystack: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(haystack);
  return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}
