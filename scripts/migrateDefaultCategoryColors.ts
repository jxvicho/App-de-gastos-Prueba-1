/**
 * Migración puntual: actualiza el colorHex de las categorías EXISTENTES que
 * coincidan por nombre EXACTO con una de las 9 categorías por defecto (ver
 * src/utils/defaultCategories.ts), para TODOS los usuarios — no solo
 * javier@test.com. No toca categorías personalizadas (nombres distintos a
 * estos 9), ni isArchived, ni ningún otro campo.
 */
import { prisma } from "../src/config/prisma";
import { DEFAULT_CATEGORIES } from "../src/utils/defaultCategories";

async function main() {
  console.log("Migrando colores de las 9 categorías por defecto para todos los usuarios...\n");

  let totalUpdated = 0;
  for (const def of DEFAULT_CATEGORIES) {
    const result = await prisma.category.updateMany({
      where: { name: def.name },
      data: { colorHex: def.colorHex },
    });
    console.log(`  ${def.name} -> ${def.colorHex} (${result.count} fila(s) actualizadas)`);
    totalUpdated += result.count;
  }

  console.log(`\nTotal actualizado: ${totalUpdated} categorías.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
