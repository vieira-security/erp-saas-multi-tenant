import type { BranchSummaryDto } from "@erp/contracts";

/**
 * Filial atual = a da rota (`/branches/[branchId]/...`). O último `branchId` usado fica no localStorage só como
 * preferência (não é segredo nem autorização); leitura/escrita toleram storage indisponível.
 */
export const LAST_BRANCH_KEY = "erp.lastBranchId";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function branchPath(branchId: string, segment = ""): string {
  const base = `/branches/${encodeURIComponent(branchId)}`;
  return segment === "" ? base : `${base}/${segment}`;
}

/** Segmento depois de `/branches/[branchId]` (`"orders"`, `"admin/companies"`, `""`). */
export function sectionOf(pathname: string): string {
  const match = /^\/branches\/[^/]+\/?(.*)$/.exec(pathname);
  return (match?.[1] ?? "").replace(/\/+$/, "");
}

/**
 * Caminho ao trocar de filial: mantém a tela atual quando ela continua permitida na filial nova; senão, início da filial.
 */
export function switchBranchPath(pathname: string, nextBranchId: string, isAllowed: (segment: string) => boolean): string {
  const segment = sectionOf(pathname);
  return branchPath(nextBranchId, segment !== "" && isAllowed(segment) ? segment : "");
}

export function readLastBranch(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(LAST_BRANCH_KEY) ?? null;
    return value !== null && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberBranch(branchId: string): void {
  if (!UUID.test(branchId)) return;
  try {
    globalThis.localStorage?.setItem(LAST_BRANCH_KEY, branchId);
  } catch {
    // storage bloqueado/cheio: só perde a preferência
  }
}

/** Última filial usada, se ainda está entre as operáveis; senão a primeira. `null` = nenhuma filial. */
export function pickInitialBranch(branches: readonly BranchSummaryDto[], remembered: string | null): string | null {
  return branches.find((b) => b.id === remembered)?.id ?? branches[0]?.id ?? null;
}
