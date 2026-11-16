/**
 * Access token SOMENTE em memória (variável de closure). Nunca em localStorage, sessionStorage, IndexedDB ou cookie
 * legível: recarregar a página perde o token, e a sessão volta pelo `/auth/refresh` (cookie HttpOnly gerido pela API).
 */
export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

export function createMemoryTokenStore(): TokenStore {
  let token: string | null = null;
  return {
    get: () => token,
    set: (value) => {
      token = value;
    },
    clear: () => {
      token = null;
    },
  };
}
