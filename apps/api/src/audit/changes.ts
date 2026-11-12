/**
 * `metadata.changes` dos eventos `*.updated` (KAN-41): `{ campo: { from, to } }` SÓ com os campos que mudaram.
 * Valores normalizados para JSON estável: dinheiro (`Decimal` do Prisma, sempre numeric(12,2) neste schema) como string
 * com 2 casas (`"25.00"`), datas em ISO 8601, ausente/`undefined` como `null`. Nada de objeto ou lista: um campo que não
 * seja escalar é bug (falha), para nunca despejar um registro inteiro no log.
 */
export type AuditScalar = string | number | boolean | null;

export interface AuditFieldChange {
  readonly from: AuditScalar;
  readonly to: AuditScalar;
}

export type AuditChanges<K extends string> = Readonly<Partial<Record<K, AuditFieldChange>>>;

export class UnsupportedAuditValueError extends Error {
  override readonly name = "UnsupportedAuditValueError";
  constructor(field: string) {
    super(`Audit value of field ${field} is not a scalar`);
  }
}

function isDecimalLike(value: object): value is { toFixed(decimals: number): string } {
  return typeof (value as { toFixed?: unknown }).toFixed === "function";
}

/** Normaliza um valor para o histórico (dinheiro `Decimal` -> `"25.00"`, `Date` -> ISO, `undefined` -> `null`). */
export function auditValue(value: unknown, field = "<value>"): AuditScalar {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsupportedAuditValueError(field);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && !Array.isArray(value) && isDecimalLike(value)) return value.toFixed(2);
  throw new UnsupportedAuditValueError(field);
}

/**
 * Compara `before` (estado gravado) com `after` (o que foi pedido) nos `fields` informados. Campo ausente em `after`
 * (`undefined`, semântica de PATCH) não entra; campo cujo valor normalizado é igual também não. Sem mudança = `{}`.
 */
export function diffChanges<K extends string>(
  before: Readonly<Record<K, unknown>>,
  after: Readonly<Partial<Record<K, unknown>>>,
  fields: readonly K[],
): AuditChanges<K> {
  const changes: Partial<Record<K, AuditFieldChange>> = {};
  for (const field of fields) {
    if (!Object.hasOwn(after, field) || after[field] === undefined) continue;
    const from = auditValue(before[field], field);
    const to = auditValue(after[field], field);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function hasChanges(changes: AuditChanges<string>): boolean {
  return Object.keys(changes).length > 0;
}
