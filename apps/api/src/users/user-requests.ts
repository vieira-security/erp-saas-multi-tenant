import type { ValidationIssue } from "@erp/contracts";
import { AUTH_SECURITY_POLICY } from "../auth/auth-security-policy.js";
import { isAcceptablePasswordInput } from "../auth/password/password-hasher.js";
import { ValidationFailedError } from "../http/api-error.js";
import { checked, list, nested, nullable, parseInput, required, text, uuid, type Parser } from "../http/input.js";
import { normalizeEmployeeNumber } from "./employee-number.js";

/**
 * Corpos da gestão de funcionários (contrato `packages/contracts/src/users.ts`), com o parser estrito do repo: campo
 * desconhecido (inclusive `tenantId`, e `employeeNumber` no PATCH) = `unknown_field`.
 */

/** Limites publicados no contrato. */
export const USER_NAME_MAX = 200;
export const USER_ROLES_MAX = 50;

/** Matrícula normalizada pela regra do login (`normalizeEmployeeNumber`); inválida = `invalid_format`. */
const employeeNumber = checked((value) => {
  const normalized = normalizeEmployeeNumber(value);
  return normalized ? { ok: true, value: normalized } : { ok: false, issue: "invalid_format" };
});

/**
 * Senha temporária pela política do Auth (sem trim: espaço é caractere da senha). Curta = `too_short`; acima do limite
 * de bytes = `too_long`. O valor nunca aparece em `details` nem em log.
 */
const temporaryPassword: Parser<string> = (raw) => {
  if (typeof raw !== "string") return { ok: false, issue: "invalid_type" };
  if (raw.length === 0) return { ok: false, issue: "too_short" };
  if (!isAcceptablePasswordInput(raw)) return { ok: false, issue: "too_long" };
  if ([...raw].length < AUTH_SECURITY_POLICY.password.minLength) return { ok: false, issue: "too_short" };
  return { ok: true, value: raw };
};

export interface CreateUserInput {
  readonly name: string;
  readonly employeeNumber: string;
  readonly temporaryPassword: string;
}

export function parseCreateUser(body: unknown): CreateUserInput {
  return parseInput(body, {
    name: required(text(USER_NAME_MAX)),
    employeeNumber: required(employeeNumber),
    temporaryPassword: required(temporaryPassword),
  });
}

export function parseUpdateUser(body: unknown): { name: string } {
  return parseInput(body, { name: required(text(USER_NAME_MAX)) });
}

export function parseResetPassword(body: unknown): { temporaryPassword: string } {
  return parseInput(body, { temporaryPassword: required(temporaryPassword) });
}

export interface RoleAssignmentInput {
  readonly roleId: string;
  readonly branchId: string | null;
}

/** Chave de uma atribuição (role + escopo). */
export function assignmentKey(a: RoleAssignmentInput): string {
  return a.branchId === null ? a.roleId : `${a.roleId}:${a.branchId}`;
}

/** Até 50 itens `{ roleId, branchId }`; par repetido = `invalid_value` no item repetido (`roles[i]`). */
export function parseReplaceRoles(body: unknown): RoleAssignmentInput[] {
  const { roles } = parseInput(body, {
    roles: required(list(nested({ roleId: required(uuid), branchId: required(nullable(uuid)) }), 0, USER_ROLES_MAX)),
  });
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  roles.forEach((role, index) => {
    const key = assignmentKey(role);
    if (seen.has(key)) issues.push({ field: `roles[${index}]`, issue: "invalid_value" });
    seen.add(key);
  });
  if (issues.length > 0) throw new ValidationFailedError(issues);
  return roles;
}
