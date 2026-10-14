/**
 * Matrícula (decisão de produto do M2): trim + uppercase, zeros à esquerda PRESERVADOS ("007" nunca vira "7"),
 * somente `[A-Z0-9._-]`, 1-32 caracteres. Mesma função no cadastro, no login e em qualquer comparação; o banco impõe o
 * mesmo formato (`users_employee_number_check`). O valor bruto é validado como ASCII ANTES do uppercase, para que
 * mapeamentos Unicode (ex.: `ı` → `I`, `ﬀ` → `FF`) não transformem uma entrada inválida em matrícula válida.
 */
export const EMPLOYEE_NUMBER_FORMAT = /^[A-Z0-9._-]{1,32}$/;
const RAW_ALLOWED = /^[A-Za-z0-9._-]{1,32}$/;

/** Matrícula normalizada, ou `null` se a entrada não for uma matrícula válida. */
export function normalizeEmployeeNumber(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const trimmed = raw.trim();
  if (!RAW_ALLOWED.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  return EMPLOYEE_NUMBER_FORMAT.test(normalized) ? normalized : null;
}
