import type { Money } from "@erp/contracts";
import { AuthContextService } from "../../auth/context/auth-context.js";
import { PasswordHasher } from "../../auth/password/password-hasher.js";
import { satisfiesPasswordPolicy } from "../../auth/password.service.js";
import { BranchStatus, ProductStatus, TenantStatus, UserStatus, type PrismaClient } from "../../generated/prisma/client.js";
import { BranchService } from "../../organization/branch.service.js";
import { CompanyService } from "../../organization/company.service.js";
import { BranchProductService } from "../../products/branch-product.service.js";
import { CategoryService } from "../../products/category.service.js";
import { ProductService } from "../../products/product.service.js";
import { optionGroup, type OptionGroupValue } from "../../products/validation.js";
import { TenantContextService } from "../../tenancy/tenant-context.js";
import { TenantScope } from "../../tenancy/tenant-scope.js";
import type { DefaultRoleCode } from "../../tenants/default-roles.js";
import { TenantProvisioningService } from "../../tenants/tenant-provisioning.service.js";
import { PERMISSION_CATALOG } from "./permissions.js";

/**
 * Seed de DESENVOLVIMENTO (KAN-51): um tenant demo com empresa, filiais, usuários das roles padrão e um cardápio pequeno,
 * para o frontend logar localmente com dados reais. Separado do seed de produção (`seed.ts`, só o catálogo de permissões).
 *
 * Segurança: recusa rodar em produção ou sem `ALLOW_DEV_SEED=true`; a senha dos usuários vem SÓ de `DEV_SEED_PASSWORD`
 * (nunca do código) e vira hash Argon2id via PasswordHasher. Roda como `erp_migrator` (mesma DATABASE_URL do `db:seed`).
 *
 * Idempotente: tudo é procurado pela chave natural (login_code, CNPJ, código da filial, matrícula, nome da categoria,
 * código do produto) e só o que falta é criado; nada existente é alterado (nem senha, nem status, nem preço).
 * Regras de domínio: empresa, filiais, categorias, produtos e ajustes por filial passam pelos services da API (dentro de
 * `TenantContextService.run`); roles padrão pelo TenantProvisioningService. Usuários, acessos e atribuições de role não
 * têm service ainda: vão pelo Prisma com TenantScope (exceção prevista para seed em AGENTS.md).
 */

export const DEV_SEED_ENV = {
  allow: "ALLOW_DEV_SEED",
  password: "DEV_SEED_PASSWORD",
} as const;

export class DevSeedRefusedError extends Error {
  override readonly name = "DevSeedRefusedError";
}

/** Valida o ambiente antes de abrir qualquer conexão. Nunca inclui a senha na mensagem. */
export function devSeedOptions(env: NodeJS.ProcessEnv = process.env): { password: string } {
  if (env["NODE_ENV"] === "production") {
    throw new DevSeedRefusedError("Refusing to run the development seed with NODE_ENV=production.");
  }
  if (env[DEV_SEED_ENV.allow] !== "true") {
    throw new DevSeedRefusedError(`Refusing to run the development seed: set ${DEV_SEED_ENV.allow}=true (development databases only).`);
  }
  const password = env[DEV_SEED_ENV.password];
  if (password === undefined || password === "") {
    throw new DevSeedRefusedError(`Refusing to run the development seed: ${DEV_SEED_ENV.password} is not set (password of the demo users).`);
  }
  if (!satisfiesPasswordPolicy(password)) {
    throw new DevSeedRefusedError(`Refusing to run the development seed: ${DEV_SEED_ENV.password} does not satisfy the password policy.`);
  }
  return { password };
}

// ── Dados ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DEMO_TENANT = { name: "Restaurante Demo", loginCode: "DEMO" } as const;

/** CNPJ alfanumérico de exemplo da Receita Federal (DV válido). */
export const DEMO_COMPANY = {
  legalName: "Restaurante Demo Ltda",
  tradeName: "Restaurante Demo",
  cnpj: "12ABC34501DE35",
  timezone: "America/Sao_Paulo",
} as const;

export const DEMO_BRANCHES = [
  { code: "CENTRO", name: "Centro", status: BranchStatus.ACTIVE },
  { code: "SHOPPING", name: "Shopping", status: BranchStatus.ACTIVE },
  { code: "ANTIGA", name: "Antiga (desativada)", status: BranchStatus.INACTIVE },
] as const;

type BranchCode = (typeof DEMO_BRANCHES)[number]["code"];

export interface DemoUser {
  readonly employeeNumber: string;
  readonly name: string;
  readonly role: DefaultRoleCode;
  readonly branches: readonly BranchCode[];
  readonly mustChangePassword: boolean;
}

/** Roles tenant-wide; o acesso às filiais (UserBranchAccess) diz onde cada um opera. */
export const DEMO_USERS: readonly DemoUser[] = [
  { employeeNumber: "DONO", name: "Dono Demo", role: "OWNER", branches: ["CENTRO", "SHOPPING", "ANTIGA"], mustChangePassword: false },
  { employeeNumber: "GERENTE", name: "Gerente Demo", role: "MANAGER", branches: ["CENTRO", "SHOPPING"], mustChangePassword: false },
  { employeeNumber: "CAIXA1", name: "Caixa 1 Demo", role: "ATTENDANT", branches: ["CENTRO"], mustChangePassword: false },
  { employeeNumber: "CAIXA2", name: "Caixa 2 Demo", role: "ATTENDANT", branches: ["SHOPPING"], mustChangePassword: false },
  { employeeNumber: "COZINHA", name: "Cozinha Demo", role: "KITCHEN", branches: ["CENTRO"], mustChangePassword: false },
  { employeeNumber: "TROCASENHA", name: "Troca Senha Demo", role: "ATTENDANT", branches: ["CENTRO"], mustChangePassword: true },
];

export const DEMO_CATEGORIES = [
  { name: "Lanches", sortOrder: 1 },
  { name: "Bebidas", sortOrder: 2 },
  { name: "Sobremesas", sortOrder: 3 },
] as const;

type CategoryName = (typeof DEMO_CATEGORIES)[number]["name"];

interface DemoOptionInput {
  readonly name: string;
  readonly priceDelta?: Money;
  /** Código de outro produto demo (combo); resolvido para o id na criação. */
  readonly linkedProductCode?: string;
}

export interface DemoProduct {
  readonly code: string;
  readonly name: string;
  readonly category: CategoryName;
  readonly basePrice: Money;
  readonly description?: string;
  readonly status?: ProductStatus;
  readonly optionGroups?: readonly { name: string; minChoices: number; maxChoices: number; options: readonly DemoOptionInput[] }[];
}

/** Em ordem de criação: as bebidas vêm antes do combo que as vincula. */
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { code: "REFRI", name: "Refrigerante lata", category: "Bebidas", basePrice: "6.00" },
  { code: "SUCO", name: "Suco natural", category: "Bebidas", basePrice: "9.00" },
  { code: "AGUA", name: "Água mineral", category: "Bebidas", basePrice: "4.00" },
  {
    code: "BATATA",
    name: "Batata frita",
    category: "Lanches",
    basePrice: "12.00",
    optionGroups: [
      { name: "Tamanho", minChoices: 1, maxChoices: 1, options: [{ name: "P" }, { name: "M", priceDelta: "4.00" }, { name: "G", priceDelta: "8.00" }] },
    ],
  },
  {
    code: "XSALADA",
    name: "X-Salada",
    category: "Lanches",
    basePrice: "22.00",
    optionGroups: [
      {
        name: "Adicionais",
        minChoices: 0,
        maxChoices: 3,
        options: [
          { name: "Bacon", priceDelta: "5.00" },
          { name: "Queijo extra", priceDelta: "3.00" },
          { name: "Ovo", priceDelta: "2.50" },
        ],
      },
    ],
  },
  { code: "XBURGER", name: "X-Burger", category: "Lanches", basePrice: "24.00", description: "Preço diferente na filial Shopping" },
  {
    code: "COMBO1",
    name: "Combo X-Burger + bebida",
    category: "Lanches",
    basePrice: "32.00",
    optionGroups: [
      {
        name: "Bebida",
        minChoices: 1,
        maxChoices: 1,
        options: [
          { name: "Refrigerante lata", linkedProductCode: "REFRI" },
          { name: "Suco natural", priceDelta: "2.00", linkedProductCode: "SUCO" },
          { name: "Água mineral", linkedProductCode: "AGUA" },
        ],
      },
    ],
  },
  { code: "HOTDOG", name: "Cachorro-quente", category: "Lanches", basePrice: "15.00", status: ProductStatus.INACTIVE, description: "Produto inativo" },
  { code: "PUDIM", name: "Pudim", category: "Sobremesas", basePrice: "10.00", description: "Indisponível na filial Shopping" },
  { code: "SORVETE", name: "Sorvete", category: "Sobremesas", basePrice: "8.00" },
];

export const DEMO_BRANCH_SETTINGS = [
  { branch: "SHOPPING", product: "XBURGER", available: true, price: "27.90" },
  { branch: "SHOPPING", product: "PUDIM", available: false, price: null },
] as const satisfies readonly { branch: BranchCode; product: string; available: boolean; price: Money | null }[];

// ── Execução ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DevSeedSummary {
  readonly tenantId: string;
  readonly tenantCreated: boolean;
  /** Quantos registros ESTA execução criou (0 em tudo numa segunda execução). */
  readonly created: {
    readonly roles: number;
    /** M7: setor de preparo padrão ("Cozinha"), pelo provisionamento. */
    readonly kitchenSectors: number;
    readonly companies: number;
    readonly branches: number;
    readonly users: number;
    readonly branchAccesses: number;
    readonly userRoles: number;
    readonly categories: number;
    readonly products: number;
    readonly branchSettings: number;
  };
}

export async function seedDevData(prisma: PrismaClient, options: { password: string }, hasher = new PasswordHasher()): Promise<DevSeedSummary> {
  const known = await prisma.permission.count({ where: { code: { in: PERMISSION_CATALOG.map((p) => p.code) } } });
  if (known !== PERMISSION_CATALOG.length) {
    throw new Error("The permission catalog is incomplete: run `npm run db:seed` before `npm run db:seed:dev`.");
  }

  let tenant = await prisma.tenant.findUnique({ where: { loginCode: DEMO_TENANT.loginCode } });
  const tenantCreated = tenant === null;
  tenant ??= await prisma.tenant.create({ data: { name: DEMO_TENANT.name, status: TenantStatus.ACTIVE, loginCode: DEMO_TENANT.loginCode } });

  const tenants = new TenantContextService();
  const scope = new TenantScope(tenants);
  const authContext = new AuthContextService(tenants);
  const services = {
    provisioning: new TenantProvisioningService(prisma, scope),
    companies: new CompanyService(prisma, scope, authContext),
    branches: new BranchService(prisma, scope, authContext),
    categories: new CategoryService(prisma, scope, authContext),
    products: new ProductService(prisma, scope, authContext),
    branchProducts: new BranchProductService(prisma, scope, authContext),
  };

  return tenants.run({ tenantId: tenant.id }, async () => {
    const created = { roles: 0, kitchenSectors: 0, companies: 0, branches: 0, users: 0, branchAccesses: 0, userRoles: 0, categories: 0, products: 0, branchSettings: 0 };

    const provisioning = await services.provisioning.provisionDefaultRoles();
    if (provisioning.conflicts.length > 0) {
      throw new Error(`Default role codes taken by custom roles in the demo tenant: ${provisioning.conflicts.join(", ")}`);
    }
    created.roles = provisioning.created.length;
    if ((await services.provisioning.provisionDefaultKitchenSector()).created) created.kitchenSectors++;
    const roles = await prisma.role.findMany({ where: scope.where({ isSystem: true }), select: { id: true, code: true } });
    const roleId = (code: DefaultRoleCode) => roles.find((r) => r.code === code)!.id;

    let company = await prisma.company.findFirst({ where: scope.where({ cnpj: DEMO_COMPANY.cnpj }), select: { id: true } });
    if (!company) {
      company = await services.companies.create({ ...DEMO_COMPANY });
      created.companies++;
    }

    const branchIds = new Map<BranchCode, string>();
    for (const def of DEMO_BRANCHES) {
      const existing = await prisma.branch.findFirst({ where: scope.where({ code: def.code }), select: { id: true } });
      if (existing) {
        branchIds.set(def.code, existing.id);
        continue;
      }
      const branch = await services.branches.create({ companyId: company.id, name: def.name, code: def.code });
      if (def.status === BranchStatus.INACTIVE) await services.branches.deactivate(branch.id);
      branchIds.set(def.code, branch.id);
      created.branches++;
    }

    const userIds = new Map<string, string>();
    for (const def of DEMO_USERS) {
      const existing = await prisma.user.findFirst({ where: scope.where({ employeeNumber: def.employeeNumber }), select: { id: true } });
      if (existing) {
        userIds.set(def.employeeNumber, existing.id);
        continue;
      }
      const user = await prisma.user.create({
        data: scope.data({
          name: def.name,
          employeeNumber: def.employeeNumber,
          passwordHash: await hasher.hash(options.password),
          status: UserStatus.ACTIVE,
          mustChangePassword: def.mustChangePassword,
        }),
        select: { id: true },
      });
      userIds.set(def.employeeNumber, user.id);
      created.users++;
    }

    // ON CONFLICT DO NOTHING: acessos/atribuições já existentes ficam como estão.
    const accesses = await prisma.userBranchAccess.createMany({
      data: DEMO_USERS.flatMap((u) => u.branches.map((b) => scope.data({ userId: userIds.get(u.employeeNumber)!, branchId: branchIds.get(b)! }))),
      skipDuplicates: true,
    });
    created.branchAccesses = accesses.count;
    // Atribuição tenant-wide (branch_id NULL): o índice único parcial user_roles_tenant_scope_key barra a duplicata.
    const assignments = await prisma.userRole.createMany({
      data: DEMO_USERS.map((u) => scope.data({ userId: userIds.get(u.employeeNumber)!, roleId: roleId(u.role), branchId: null })),
      skipDuplicates: true,
    });
    created.userRoles = assignments.count;

    const categoryIds = new Map<CategoryName, string>();
    for (const def of DEMO_CATEGORIES) {
      let category = await prisma.productCategory.findFirst({ where: scope.where({ name: def.name }), orderBy: { createdAt: "asc" }, select: { id: true } });
      if (!category) {
        category = await services.categories.create({ name: def.name, sortOrder: def.sortOrder });
        created.categories++;
      }
      categoryIds.set(def.name, category.id);
    }

    const productIds = new Map<string, string>();
    for (const [index, def] of DEMO_PRODUCTS.entries()) {
      const existing = await prisma.product.findFirst({ where: scope.where({ code: def.code }), select: { id: true } });
      if (existing) {
        productIds.set(def.code, existing.id);
        continue;
      }
      const product = await services.products.create({
        name: def.name,
        code: def.code,
        description: def.description ?? null,
        categoryId: categoryIds.get(def.category)!,
        basePrice: def.basePrice,
        sortOrder: index + 1,
        optionGroups: (def.optionGroups ?? []).map((group) => validGroup(group, productIds)),
      });
      if (def.status === ProductStatus.INACTIVE) await services.products.setStatus(product.id, ProductStatus.INACTIVE);
      productIds.set(def.code, product.id);
      created.products++;
    }

    for (const def of DEMO_BRANCH_SETTINGS) {
      const branchId = branchIds.get(def.branch)!;
      const productId = productIds.get(def.product)!;
      if (await prisma.branchProductSetting.findFirst({ where: scope.where({ branchId, productId }), select: { id: true } })) continue;
      await services.branchProducts.upsert(branchId, productId, { available: def.available, price: def.price });
      created.branchSettings++;
    }

    return { tenantId: tenant.id, tenantCreated, created };
  });
}

/** Passa o grupo pelo mesmo parser do HTTP (min/max/opções), com o combo resolvido de código para id. */
function validGroup(group: NonNullable<DemoProduct["optionGroups"]>[number], productIds: ReadonlyMap<string, string>): OptionGroupValue {
  const raw = {
    name: group.name,
    minChoices: group.minChoices,
    maxChoices: group.maxChoices,
    options: group.options.map((option) => ({
      name: option.name,
      ...(option.priceDelta ? { priceDelta: option.priceDelta } : {}),
      ...(option.linkedProductCode ? { linkedProductId: productIds.get(option.linkedProductCode) } : {}),
    })),
  };
  const parsed = optionGroup(raw);
  if (!parsed.ok) throw new Error(`Invalid demo option group "${group.name}": ${JSON.stringify(parsed)}`);
  return parsed.value;
}
