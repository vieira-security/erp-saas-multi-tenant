import type { ValidationIssue, ValidationIssueCode } from "@erp/contracts";
import { ValidationFailedError } from "./api-error.js";

/**
 * Parsing estrito de corpo e query, sem dependência externa. Cada campo declara um parser; qualquer campo não declarado
 * (inclusive `tenantId`) vira `unknown_field` — proteção contra mass assignment. Todos os problemas são reunidos num único
 * `ValidationFailedError` (400). O resultado só contém campos declarados e presentes.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssueCode };
export type Parser<T> = (raw: unknown) => Parsed<T>;

interface FieldSpec<T> {
  readonly required: boolean;
  readonly parse: Parser<T>;
}

export function required<T>(parse: Parser<T>): FieldSpec<T> {
  return { required: true, parse };
}

export function optional<T>(parse: Parser<T>): FieldSpec<T> & { readonly optional: true } {
  return { required: false, parse, optional: true };
}

type Spec = Record<string, FieldSpec<unknown>>;
type ValueOf<F> = F extends FieldSpec<infer T> ? T : never;
type RequiredKeys<S extends Spec> = { [K in keyof S]: S[K] extends { optional: true } ? never : K }[keyof S];
type OptionalKeys<S extends Spec> = Exclude<keyof S, RequiredKeys<S>>;
export type Output<S extends Spec> = { [K in RequiredKeys<S>]: ValueOf<S[K]> } & { [K in OptionalKeys<S>]?: ValueOf<S[K]> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Valida um objeto (corpo JSON ou query). Corpo ausente/não-objeto = `{ field: "body", issue: "invalid_type" }`. */
export function parseInput<S extends Spec>(input: unknown, spec: S, part: "body" | "query" = "body"): Output<S> {
  const source = input === undefined && part === "query" ? {} : input;
  if (!isPlainObject(source)) throw new ValidationFailedError([{ field: part, issue: "invalid_type" }]);
  const issues: ValidationIssue[] = [];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(spec, key)) issues.push({ field: key, issue: "unknown_field" });
  }
  for (const [key, field] of Object.entries(spec)) {
    const raw = source[key];
    if (raw === undefined) {
      if (field.required) issues.push({ field: key, issue: "required" });
      continue;
    }
    const result = field.parse(raw);
    if (result.ok) out[key] = result.value;
    else issues.push({ field: key, issue: result.issue });
  }
  if (issues.length > 0) throw new ValidationFailedError(issues);
  return out as Output<S>;
}

/** Texto aparado com tamanho 1..max (vazio após trim = `too_short`). */
export function text(max: number): Parser<string> {
  return (raw) => {
    if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
    const value = raw.trim();
    if (value.length === 0) return { ok: false, issue: "too_short" };
    if (value.length > max) return { ok: false, issue: "too_long" };
    return { ok: true, value };
  };
}

/** String validada por uma função que devolve o valor normalizado ou o motivo da rejeição. */
export function checked(check: (value: string) => Parsed<string>): Parser<string> {
  return (raw) => (typeof raw === "string" ? check(raw) : { ok: false, issue: "invalid_type" });
}

/** Aceita `null` explicitamente (ex.: remover CNPJ da filial). */
export function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (raw) => (raw === null ? { ok: true, value: null } : parse(raw));
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuid: Parser<string> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  return UUID.test(raw) ? { ok: true, value: raw.toLowerCase() } : { ok: false, issue: "invalid_format" };
};

export function oneOf<const V extends string>(values: readonly V[]): Parser<V> {
  return (raw) => {
    if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
    return (values as readonly string[]).includes(raw) ? { ok: true, value: raw as V } : { ok: false, issue: "invalid_value" };
  };
}

/** Inteiro positivo vindo da query string (`"2"`), entre 1 e `max`. */
export function queryInt(max: number): Parser<number> {
  return (raw) => {
    if (typeof raw !== "string" || !/^[0-9]{1,6}$/.test(raw)) return { ok: false, issue: "invalid_format" };
    const value = Number(raw);
    if (value < 1 || value > max) return { ok: false, issue: "invalid_value" };
    return { ok: true, value };
  };
}
