-- AlterTable
-- Achica petName de VARCHAR(15) a VARCHAR(11). El USING trunca cualquier
-- valor existente más largo que 11 caracteres en vez de fallar (en este
-- momento no hay datos reales en producción, solo texto de prueba local).
ALTER TABLE "users" ALTER COLUMN "petName" TYPE VARCHAR(11) USING substring("petName" from 1 for 11);
