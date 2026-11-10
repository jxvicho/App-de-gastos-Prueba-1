-- Orden de las reglas de categorización: 0 = se evalúa primero. Las reglas existentes conservan el orden actual (más recientes primero).
ALTER TABLE "category_rules" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

UPDATE "category_rules" r
SET "position" = s.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "createdAt" DESC) - 1 AS rn
  FROM "category_rules"
) s
WHERE r.id = s.id;
