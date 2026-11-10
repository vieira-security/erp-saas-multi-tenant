import argon2 from "argon2";
import { Injectable } from "@nestjs/common";
import { AUTH_SECURITY_POLICY } from "../auth-security-policy.js";

/**
 * Parâmetros do Argon2id, centralizados (baseline OWASP: m = 19 MiB, t = 2, p = 1). O salt (16 bytes aleatórios) é gerado
 * pela biblioteca a cada hash; algoritmo, versão, parâmetros e salt ficam no próprio hash (formato PHC autocontido),
 * então hashes antigos continuam verificáveis depois de uma mudança daqui e são re-hasheados no próximo login.
 */
export const ARGON2ID_PARAMS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/** Senha que nunca deve chegar ao Argon2id (vazia, não-string ou acima de `password.maxBytes`). Nunca carrega a senha. */
export class PasswordInputRejectedError extends Error {
  override readonly name = "PasswordInputRejectedError";
  constructor() {
    super("Password input rejected (empty, not a string or too large)");
  }
}

/** Hash armazenado que não é um Argon2id válido (dado corrompido ou outro algoritmo). Nunca carrega o hash. */
export class InvalidPasswordHashError extends Error {
  override readonly name = "InvalidPasswordHashError";
  constructor() {
    super("Stored password hash is not a valid Argon2id hash");
  }
}

/** Só Argon2id é aceito: qualquer outro prefixo (argon2i/argon2d, bcrypt, SHA...) é tratado como hash inválido. */
const ARGON2ID_PREFIX = "$argon2id$";

export function isAcceptablePasswordInput(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length > 0 &&
    Buffer.byteLength(password, "utf8") <= AUTH_SECURITY_POLICY.password.maxBytes
  );
}

/**
 * Único ponto do sistema que transforma senha em hash ou verifica senha. Nunca loga nem devolve a senha; erros nunca
 * carregam a senha nem o hash. Refresh tokens NÃO passam por aqui (são aleatórios de alta entropia: SHA-256 basta).
 */
@Injectable()
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    if (!isAcceptablePasswordInput(password)) throw new PasswordInputRejectedError();
    return argon2.hash(password, ARGON2ID_PARAMS);
  }

  /**
   * `true` só se `password` corresponde ao hash Argon2id. Entrada inaceitável = `false` sem calcular nada. Hash que não é
   * Argon2id (ou corrompido) lança `InvalidPasswordHashError`, para o chamador tratar como falha genérica.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    if (typeof hash !== "string" || !hash.startsWith(ARGON2ID_PREFIX)) throw new InvalidPasswordHashError();
    if (!isAcceptablePasswordInput(password)) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      throw new InvalidPasswordHashError();
    }
  }

  /** Hash válido mas com parâmetros diferentes dos atuais: deve ser recalculado após um login correto. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2ID_PARAMS);
    } catch {
      return true;
    }
  }

  /**
   * Gasta o mesmo trabalho de uma verificação real quando não há hash para verificar (matrícula inexistente, conta
   * desativada/bloqueada), para que o tempo de resposta não revele qual foi o caso.
   */
  async burnVerification(password: string): Promise<void> {
    this.dummyHash ??= argon2.hash("dummy-password-for-timing-equalization", ARGON2ID_PARAMS);
    const candidate = isAcceptablePasswordInput(password) ? password : "x";
    await argon2.verify(await this.dummyHash, candidate).catch(() => false);
  }
}
