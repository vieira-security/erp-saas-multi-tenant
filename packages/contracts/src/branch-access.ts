import type { BranchSummaryDto } from "./branches.js";

/**
 * Acesso de um usuário a filiais (UserBranchAccess). Diz ONDE o usuário pode operar; O QUE ele pode fazer vem das roles.
 *
 * GET    /users/:userId/branch-access              `user.read` (tenant) -> 200 BranchAccessDto[] | 404 not_found (usuário)
 * PUT    /users/:userId/branch-access/:branchId    `user.manage` NA FILIAL :branchId -> 201 criado | 200 já existia
 *                                                   404 not_found (usuário) | 409 branch_inactive
 * DELETE /users/:userId/branch-access/:branchId    `user.manage` NA FILIAL :branchId -> 204 | 404 (usuário/acesso)
 *                                                   409 branch_access_in_use (o usuário tem role escopada nessa filial)
 *
 * "Na filial" = quem concede/revoga precisa ter `user.manage` e acesso àquela filial: ninguém distribui acesso a uma
 * filial onde não pode operar. Sem acesso (ou filial inexistente/de outro tenant) -> 403 forbidden.
 * Também 403 se o usuário alvo tiver, em qualquer role, permissão que o ator não tem nessa filial (ex.: MANAGER não
 * concede nem revoga acesso de um OWNER).
 * Sem corpo nos requests.
 */
export interface BranchAccessDto {
  readonly userId: string;
  readonly branchId: string;
  readonly createdAt: string;
  readonly branch: BranchSummaryDto;
}
