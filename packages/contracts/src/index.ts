// Contratos HTTP compartilhados (contract-first). A API importa SOMENTE tipos daqui (`import type`): o pacote ainda
// não tem build para runtime do Node. Valores (`as const`, constantes) são para o frontend.
export * from "./common.js";
export * from "./organization.js";
export * from "./companies.js";
export * from "./branches.js";
export * from "./branch-access.js";
export * from "./products.js";
export * from "./orders.js";
