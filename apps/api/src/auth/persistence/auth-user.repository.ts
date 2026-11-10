import { Prisma, type PrismaClient, type UserStatus } from "../../generated/prisma/client.js";
import type { TenantScope } from "../../tenancy/tenant-scope.js";

/** Visão de credencial do User, só para o Auth. `passwordHash` nunca sai do módulo auth. */
export interface UserCredentials {
  readonly id: string;
  readonly status: UserStatus;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly failedLoginAttempts: number;
  readonly lockedUntil: Date | null;
}

const CREDENTIAL_FIELDS = {
  id: true,
  status: true,
  passwordHash: true,
  mustChangePassword: true,
  failedLoginAttempts: true,
  lockedUntil: true,
} as const satisfies Prisma.UserSelect;

export type AuthUserDb = Pick<PrismaClient, "user">;

/**
 * Leitura e escrita dos campos de credencial do User, sempre no tenant do contexto (TenantScope). Escritas por chave usam
 * `where: scope.where({ id })`: usuário de outro tenant = não encontrado.
 */
export class AuthUserRepository {
  constructor(
    private readonly db: AuthUserDb,
    private readonly scope: TenantScope,
  ) {}

  /** Recebe a matrícula JÁ normalizada (`normalizeEmployeeNumber`); o banco só guarda o formato normalizado. */
  async findByEmployeeNumber(employeeNumber: string): Promise<UserCredentials | null> {
    return this.db.user.findFirst({ where: this.scope.where({ employeeNumber }), select: CREDENTIAL_FIELDS });
  }

  async findById(id: string): Promise<UserCredentials | null> {
    return this.db.user.findFirst({ where: this.scope.where({ id }), select: CREDENTIAL_FIELDS });
  }

  /**
   * Incremento atômico (`failed_login_attempts = failed_login_attempts + 1`, com lock de linha até o fim da transação):
   * tentativas concorrentes nunca perdem incremento. Devolve o valor após o incremento.
   */
  async incrementFailedAttempts(id: string): Promise<number> {
    const user = await this.db.user.update({
      where: this.scope.where({ id }),
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    return user.failedLoginAttempts;
  }

  /** Bloqueio temporário: `locked_until` + contador zerado (após o prazo, o usuário volta a ter todas as tentativas). */
  async lockTemporarily(id: string, lockedUntil: Date): Promise<void> {
    await this.db.user.update({ where: this.scope.where({ id }), data: { lockedUntil, failedLoginAttempts: 0 } });
  }

  /** Login correto: zera contador e bloqueio temporário, registra `last_login_at` e, se preciso, o hash recalculado. */
  async registerSuccessfulLogin(id: string, at: Date, rehashed: string | null): Promise<void> {
    await this.db.user.update({
      where: this.scope.where({ id }),
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: at, ...(rehashed ? { passwordHash: rehashed } : {}) },
    });
  }

  /**
   * Novo hash de senha. `resetLockout` (reset administrativo) também zera contador e bloqueio temporário; o status
   * (`LOCKED`/`DISABLED`) nunca é alterado aqui. `false` se o usuário não existe no tenant.
   */
  async setPasswordHash(id: string, passwordHash: string, options: { mustChangePassword: boolean; resetLockout: boolean }): Promise<boolean> {
    const data: Prisma.UserUpdateInput = { passwordHash, mustChangePassword: options.mustChangePassword };
    if (options.resetLockout) {
      data.failedLoginAttempts = 0;
      data.lockedUntil = null;
    }
    try {
      await this.db.user.update({ where: this.scope.where({ id }), data });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return false;
      throw error;
    }
  }
}
