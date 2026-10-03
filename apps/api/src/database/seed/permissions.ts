import type { PrismaClient } from "../../generated/prisma/client.js";

export interface PermissionDefinition {
  code: string;
  module: string;
  description: string;
}

/**
 * Catálogo técnico global inicial, controlado pelo sistema. `code` é identificador estável:
 * renomear exige migração dos vínculos e do código da aplicação que dependa dele.
 */
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  { code: "organization.read", module: "organization", description: "Visualizar dados da empresa" },
  { code: "organization.manage", module: "organization", description: "Gerenciar dados da empresa" },
  { code: "branch.read", module: "organization", description: "Visualizar filiais" },
  { code: "branch.manage", module: "organization", description: "Gerenciar filiais" },
  { code: "user.read", module: "users", description: "Visualizar usuários" },
  { code: "user.manage", module: "users", description: "Gerenciar usuários" },
  { code: "role.read", module: "users", description: "Visualizar papéis" },
  { code: "role.manage", module: "users", description: "Gerenciar papéis" },
  { code: "product.read", module: "products", description: "Visualizar produtos" },
  { code: "product.manage", module: "products", description: "Gerenciar produtos" },
  { code: "order.read", module: "orders", description: "Visualizar pedidos" },
  { code: "order.create", module: "orders", description: "Criar pedidos" },
  { code: "order.cancel", module: "orders", description: "Cancelar pedidos" },
  { code: "cash.read", module: "cash", description: "Visualizar caixa" },
  { code: "cash.open", module: "cash", description: "Abrir caixa" },
  { code: "cash.close", module: "cash", description: "Fechar caixa" },
  { code: "fiscal.read", module: "fiscal", description: "Visualizar documentos fiscais" },
  { code: "fiscal.issue", module: "fiscal", description: "Emitir documentos fiscais" },
  { code: "fiscal.cancel", module: "fiscal", description: "Cancelar documentos fiscais" },
];

/**
 * Idempotente: upsert por `code`. Cria o que falta e alinha module/description ao catálogo;
 * nunca troca o `id` nem remove permissões fora do catálogo.
 */
export async function seedPermissions(prisma: PrismaClient): Promise<number> {
  for (const { code, module, description } of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, module, description },
      update: { module, description },
    });
  }
  return PERMISSION_CATALOG.length;
}
