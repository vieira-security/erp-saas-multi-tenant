import type { BranchDto, CompanyDto, MeBranchDto, MeDto, OrganizationDto, PermissionCode } from "@erp/contracts";

/**
 * Dados de EXEMPLO para `NEXT_PUBLIC_API_MOCKS=1`, inspirados no seed de dev (docs/dev-setup.md), não uma cópia dele.
 * Tipados pelos contratos (`satisfies`): se o contrato mudar, o typecheck quebra aqui. Permissões seguem a matriz
 * padrão (docs/security.md); nada de tenant em lugar nenhum.
 */

const CREATED = "2026-11-01T12:00:00.000Z";

export const MOCK_ORGANIZATION = {
  id: "0193a000-0000-7000-8000-000000000001",
  name: "Restaurante Demo",
  status: "ACTIVE",
  loginCode: "DEMO",
  trialEndsAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
} as const satisfies OrganizationDto;

const company = (n: number, tradeName: string, legalName: string, cnpj: string, status: CompanyDto["status"]): CompanyDto => ({
  id: `0193a000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`,
  legalName,
  tradeName,
  cnpj,
  status,
  timezone: "America/Sao_Paulo",
  createdAt: `2026-11-01T12:${String(n).padStart(2, "0")}:00.000Z`,
  updatedAt: CREATED,
});

export const MOCK_COMPANIES: readonly CompanyDto[] = [
  company(1, "Demo Lanches", "Demo Alimentos Ltda", "12ABC34501DE35", "ACTIVE"),
  company(2, "Demo Quiosques", "Demo Quiosques Ltda", "11222333000181", "ACTIVE"),
  company(3, "Demo Antiga", "Demo Antiga Comércio Ltda", "11444777000161", "INACTIVE"),
];

const companyId = (index: number): string => MOCK_COMPANIES[index]?.id ?? "";

const branch = (n: number, name: string, code: string, companyIndex: number, status: BranchDto["status"]): BranchDto => ({
  id: `0193a000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
  companyId: companyId(companyIndex),
  name,
  code,
  cnpj: null,
  status,
  timezone: "America/Sao_Paulo",
  createdAt: `2026-11-02T12:${String(n).padStart(2, "0")}:00.000Z`,
  updatedAt: CREATED,
});

/** 25 filiais: dá 2 páginas no `pageSize` padrão (20). */
export const MOCK_BRANCHES: readonly BranchDto[] = [
  branch(1, "Centro", "CENTRO", 0, "ACTIVE"),
  branch(2, "Shopping Norte", "SHOPPING", 0, "ACTIVE"),
  branch(3, "Antiga", "ANTIGA", 2, "INACTIVE"),
  ...Array.from({ length: 22 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return branch(i + 4, `Quiosque ${n}`, `QUIOSQUE-${n}`, 1, "ACTIVE");
  }),
];

export const [MOCK_BRANCH_CENTRO, MOCK_BRANCH_SHOPPING, MOCK_BRANCH_ANTIGA, MOCK_BRANCH_QUIOSQUE_01] = MOCK_BRANCHES as [
  BranchDto,
  BranchDto,
  BranchDto,
  BranchDto,
  ...BranchDto[],
];

// Matriz padrão (docs/security.md, `default-roles.ts` da API), só as roles usadas aqui.
const ATTENDANT: readonly PermissionCode[] = [
  "branch.read",
  "cash.open",
  "cash.read",
  "fiscal.issue",
  "fiscal.read",
  "order.create",
  "order.prepare",
  "order.read",
  "product.read",
];
const MANAGER: readonly PermissionCode[] = [
  "audit.read",
  "branch.read",
  "cash.close",
  "cash.open",
  "cash.read",
  "fiscal.cancel",
  "fiscal.issue",
  "fiscal.read",
  "order.cancel",
  "order.create",
  "order.prepare",
  "order.read",
  "organization.read",
  "product.manage",
  "product.read",
  "role.read",
  "user.manage",
  "user.read",
];
const OWNER: readonly PermissionCode[] = [
  ...MANAGER,
  "audit.read_tenant",
  "branch.manage",
  "organization.manage",
  "role.manage",
];

const sorted = (codes: readonly PermissionCode[]): PermissionCode[] => [...new Set(codes)].sort();

function companyActive(id: string): boolean {
  return MOCK_COMPANIES.find((c) => c.id === id)?.status === "ACTIVE";
}

function meBranch(source: BranchDto, permissions: readonly PermissionCode[]): MeBranchDto {
  return {
    id: source.id,
    companyId: source.companyId,
    name: source.name,
    code: source.code,
    status: source.status,
    operable: source.status === "ACTIVE" && companyActive(source.companyId),
    permissions: sorted(permissions),
  };
}

export const MOCK_PROFILES = ["mixed", "owner"] as const;
export type MockProfile = (typeof MOCK_PROFILES)[number];

/**
 * - `mixed` (padrão): ATTENDANT no tenant + MANAGER só na SHOPPING. Mostra o menu mudando com a filial e itens
 *   administrativos escondidos (sem `organization.read`/`user.read` no tenant).
 * - `owner`: OWNER no tenant, acesso às 4 filiais nomeadas.
 */
export function mockMe(profile: MockProfile): MeDto {
  if (profile === "owner") {
    return {
      user: { id: "0193a000-0000-7000-8000-000000000301", name: "Dona Demo", employeeNumber: "DONO", mustChangePassword: false },
      organization: { id: MOCK_ORGANIZATION.id, name: MOCK_ORGANIZATION.name, status: MOCK_ORGANIZATION.status, loginCode: MOCK_ORGANIZATION.loginCode },
      permissions: sorted(OWNER),
      branches: [MOCK_BRANCH_CENTRO, MOCK_BRANCH_SHOPPING, MOCK_BRANCH_ANTIGA, MOCK_BRANCH_QUIOSQUE_01].map((b) => meBranch(b, OWNER)),
    };
  }
  return {
    user: { id: "0193a000-0000-7000-8000-000000000302", name: "Ana Souza", employeeNumber: "ANA", mustChangePassword: false },
    organization: { id: MOCK_ORGANIZATION.id, name: MOCK_ORGANIZATION.name, status: MOCK_ORGANIZATION.status, loginCode: MOCK_ORGANIZATION.loginCode },
    permissions: sorted(ATTENDANT),
    branches: [
      meBranch(MOCK_BRANCH_CENTRO, ATTENDANT),
      meBranch(MOCK_BRANCH_SHOPPING, [...ATTENDANT, ...MANAGER]),
      meBranch(MOCK_BRANCH_ANTIGA, ATTENDANT),
      meBranch(MOCK_BRANCH_QUIOSQUE_01, ATTENDANT),
    ],
  };
}
