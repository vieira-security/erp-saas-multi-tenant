import type { Prisma, ProductStatus } from "../generated/prisma/client.js";

/**
 * Trava (`FOR UPDATE`) as linhas de `products` do tenant atual envolvidas numa alteração de grupos de opções e devolve o
 * estado MAIS RECENTE delas (ausentes = não existem no tenant). SQL bruto porque o Prisma não expõe `FOR UPDATE`; o filtro
 * de `tenant_id` é explícito e vem do TenantContext (quem chama passa `scope.tenantId()`). Exige `UPDATE` em `products`,
 * que `erp_app` tem.
 *
 * Invariante protegida: "combo não aninha combo" — nenhum produto tem grupos E é vinculado por opção de outro produto.
 * - dar grupos a X trava X; vincular L numa opção trava L. As duas operações sobre o mesmo produto se serializam e a
 *   segunda, depois de obter a trava, relê o estado já commitado (READ COMMITTED: cada comando vê o último commit).
 * - Todas as linhas são travadas num único comando, em ordem de `id` (uuid, sem collation): duas transações que travam
 *   os mesmos produtos (X vincula Y enquanto Y vincula X) esperam uma pela outra em vez de entrar em deadlock.
 * - Desativar o produto vinculado também atualiza a linha, então espera a trava: "vinculado precisa estar ACTIVE" vale
 *   no momento do vínculo.
 */
export async function lockProducts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: readonly string[],
): Promise<{ id: string; status: ProductStatus }[]> {
  if (ids.length === 0) return [];
  return tx.$queryRaw<{ id: string; status: ProductStatus }[]>`
    SELECT id::text AS id, status::text AS status FROM products
    WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${[...ids]}::uuid[])
    ORDER BY id FOR UPDATE`;
}
