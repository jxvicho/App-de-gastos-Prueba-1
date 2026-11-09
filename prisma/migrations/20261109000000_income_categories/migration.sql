-- Categorías de ingreso: Category.kind distingue categorías de gasto e ingreso.
CREATE TYPE "CategoryKind" AS ENUM ('EXPENSE', 'INCOME');
ALTER TABLE "categories" ADD COLUMN "kind" "CategoryKind" NOT NULL DEFAULT 'EXPENSE';

-- La categoría "Ingresos" que ya existía pasa a ser de ingreso.
UPDATE "categories" SET "kind" = 'INCOME' WHERE "name" = 'Ingresos';

-- Categorías de ingreso base para los usuarios existentes (si ya tenían una con ese nombre, se respeta).
INSERT INTO "categories" ("id","userId","name","icon","colorHex","isDefault","excludeFromTotals","isArchived","kind","createdAt")
SELECT gen_random_uuid()::text, u."id", v."name", v."icon", v."color", true, false, false, 'INCOME', now()
FROM "users" u
CROSS JOIN (VALUES
  ('Sueldo','💼','#1B8A5A'),
  ('Honorarios y freelance','🧑‍💻','#2A9D8F'),
  ('Ventas y negocio','🏪','#43A047'),
  ('Intereses e inversiones','📈','#00897B'),
  ('Reembolsos y devoluciones','↩️','#558B2F'),
  ('Regalos y transferencias','🎁','#26A69A')
) AS v("name","icon","color")
ON CONFLICT ("userId","name") DO NOTHING;
