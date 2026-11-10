-- M3: CNPJ alfanumérico (IN RFB 2.229/2024; a Receita Federal emite o formato com letras desde 31/07/2026).
-- Formato: 12 caracteres de identificação [0-9A-Z] (raiz + ordem) + 2 dígitos verificadores numéricos, sempre maiúsculo
-- e sem máscara. Os dígitos verificadores (módulo 11) continuam validados só na aplicação.
--
-- O novo formato é um SUPERCONJUNTO do anterior (^[0-9]{14}$): todo valor existente continua válido, então não há
-- conversão de dados. As constraints mantêm os nomes companies_cnpj_check e branches_cnpj_check.
-- Sem alteração de ACL/ownership, índices ou triggers.

ALTER TABLE "companies" DROP CONSTRAINT "companies_cnpj_check";
ALTER TABLE "companies" ADD CONSTRAINT "companies_cnpj_check" CHECK ("cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$');

ALTER TABLE "branches" DROP CONSTRAINT "branches_cnpj_check";
ALTER TABLE "branches" ADD CONSTRAINT "branches_cnpj_check" CHECK ("cnpj" IS NULL OR "cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$');
