-- M2 (decisão de produto): matrícula normalizada = trim + uppercase, zeros à esquerda preservados ("007" continua
-- "007"), somente [A-Z0-9._-], 1-32 caracteres. A aplicação normaliza no cadastro e no login; o banco impõe o formato.
--
-- Caminho incremental, sem perda silenciosa: matrículas existentes são normalizadas (trim + upper). A migration ABORTA,
-- com mensagem explícita, se a normalização colidir com outra matrícula do mesmo tenant ou se restar valor fora do
-- formato (ex.: caractere não permitido): esses casos exigem correção manual, nunca reescrita automática.
-- A constraint mantém o nome users_employee_number_check (substitui o CHECK de "não vazio", que o novo formato cobre).
-- O UPDATE não toca tenant_id (o trigger users_tenant_id_immutable não dispara). Sem alteração de ACL/ownership.

DO $$
DECLARE
  collisions integer;
  invalid integer;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT tenant_id, upper(btrim(employee_number)) FROM users
    GROUP BY 1, 2 HAVING count(*) > 1
  ) c;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'employee_number normalization would collide in % case(s); fix the data manually before migrating', collisions;
  END IF;

  SELECT count(*) INTO invalid FROM users WHERE upper(btrim(employee_number)) !~ '^[A-Z0-9._-]{1,32}$';
  IF invalid > 0 THEN
    RAISE EXCEPTION '% employee_number value(s) are outside ^[A-Z0-9._-]{1,32}$ after trim + upper; fix them manually', invalid;
  END IF;
END $$;

UPDATE "users"
SET "employee_number" = upper(btrim("employee_number")), "updated_at" = CURRENT_TIMESTAMP
WHERE "employee_number" <> upper(btrim("employee_number"));

ALTER TABLE "users" DROP CONSTRAINT "users_employee_number_check";
ALTER TABLE "users" ADD CONSTRAINT "users_employee_number_check" CHECK ("employee_number" ~ '^[A-Z0-9._-]{1,32}$');
