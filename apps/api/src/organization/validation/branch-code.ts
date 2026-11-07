/**
 * Código operacional da filial: trim + maiúsculo, depois `^[A-Z0-9][A-Z0-9_-]{0,31}$` (mesmo valor de
 * `BRANCH_CODE_PATTERN` em `@erp/contracts`; um teste compara os dois). Default técnico: não há regra de negócio
 * fornecida além de "normalizar com trim + uppercase" (docs/database.md).
 */
export const BRANCH_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export type BranchCodeCheck = { ok: true; value: string } | { ok: false; issue: "too_short" | "too_long" | "invalid_format" };

export function checkBranchCode(input: string): BranchCodeCheck {
  const code = input.trim().toUpperCase();
  if (code.length === 0) return { ok: false, issue: "too_short" };
  if (code.length > 32) return { ok: false, issue: "too_long" };
  if (!BRANCH_CODE.test(code)) return { ok: false, issue: "invalid_format" };
  return { ok: true, value: code };
}
