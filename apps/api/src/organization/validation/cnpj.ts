/**
 * CNPJ numérico e alfanumérico (Receita Federal, IN RFB 2.229/2024; formato com letras emitido desde 31/07/2026).
 *
 * - 14 caracteres: 12 de identificação `[0-9A-Z]` (8 de raiz + 4 de ordem) e 2 dígitos verificadores numéricos.
 * - DV pelo módulo 11 com pesos 2..9 da direita para a esquerda; cada caractere vale `código ASCII - 48`
 *   (0-9 -> 0-9, A -> 17 ... Z -> 42), o que mantém o cálculo antigo para CNPJ só numérico.
 * - Resto 0 ou 1 -> DV 0; senão DV = 11 - resto.
 * Exemplo oficial do FAQ da Receita: `12ABC34501DE` -> DV `35`.
 */

const SHAPE = /^[0-9A-Z]{12}[0-9]{2}$/;
/** Pontuação de máscara aceita na entrada (`11.222.333/0001-81`) e espaços. */
const MASK = /[.\-/\s]/g;

export type CnpjCheck = { ok: true; value: string } | { ok: false; issue: "invalid_format" | "invalid_cnpj" };

function value(char: string): number {
  return char.charCodeAt(0) - 48;
}

function checkDigit(base: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    sum += value(base[i] as string) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** Remove máscara e passa para maiúsculo. Não valida. */
export function normalizeCnpj(input: string): string {
  return input.replace(MASK, "").toUpperCase();
}

/** Normaliza e valida formato + dígitos verificadores. Rejeita sequências repetidas (`00000000000000`). */
export function checkCnpj(input: string): CnpjCheck {
  const cnpj = normalizeCnpj(input);
  if (!SHAPE.test(cnpj)) return { ok: false, issue: "invalid_format" };
  if (/^(.)\1{13}$/.test(cnpj)) return { ok: false, issue: "invalid_cnpj" };
  const first = checkDigit(cnpj.slice(0, 12));
  const second = checkDigit(cnpj.slice(0, 12) + String(first));
  if (cnpj.slice(12) !== `${first}${second}`) return { ok: false, issue: "invalid_cnpj" };
  return { ok: true, value: cnpj };
}

/** Raiz (8 primeiros caracteres): identifica a empresa; filiais da mesma empresa compartilham a raiz. */
export function cnpjRoot(cnpj: string): string {
  return cnpj.slice(0, 8);
}
