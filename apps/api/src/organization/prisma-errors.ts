import { Prisma } from "../generated/prisma/client.js";

/**
 * Violação de unique (P2002). Com driver adapter o Prisma nem sempre preenche `meta.target` do mesmo jeito; por isso a
 * identificação procura o nome da constraint/colunas em todo o `meta` e na mensagem. `hint` são trechos esperados
 * (ex.: `branches_tenant_id_code_key` ou `code`).
 */
export function isUniqueViolation(error: unknown, ...hints: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  if (hints.length === 0) return true;
  const haystack = `${JSON.stringify(error.meta ?? {})} ${error.message}`;
  return hints.some((hint) => haystack.includes(hint));
}

/** Violação de FK (P2003): ex. apagar UserBranchAccess ainda usado por UserRole escopada (`RESTRICT`). */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

/** Registro alvo de update/delete inexistente (P2025). */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}
