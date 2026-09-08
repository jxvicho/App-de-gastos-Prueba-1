/**
 * Backfill: categoriza transacciones PENDING_CONFIRMATION viejas que se
 * crearon antes de que existiera la sugerencia automática de categoría con
 * Gemini. Reusa extractTransactionFromEmail (sin duplicar el prompt),
 * pasándole un texto sintético armado con merchant/descripción/banco en
 * vez del cuerpo real del correo (que ya no tenemos guardado).
 */
import { prisma } from "../src/config/prisma";
import { extractTransactionFromEmail } from "../src/services/gemini";
import { normalizeText } from "../src/utils/text";

const USER_EMAIL = "javier@test.com";
const SLEEP_MS = 4500; // mismo rate-limit que outlookSync.ts (Gemini free tier)

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: USER_EMAIL } });
  if (!user) {
    console.error(`No se encontró el usuario ${USER_EMAIL}`);
    return;
  }

  const categories = await prisma.category.findMany({
    where: { userId: user.id, isArchived: false },
    select: { id: true, name: true },
  });
  const categoryNames = categories.map((c) => c.name);
  const categoryByNormalizedName = new Map(categories.map((c) => [normalizeText(c.name), c]));

  const targets = await prisma.transaction.findMany({
    where: { userId: user.id, status: "PENDING_CONFIRMATION", categoryId: null },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Encontradas ${targets.length} transacciones PENDING_CONFIRMATION sin categoría.\n`);

  let categorized = 0;
  let failed = 0;

  for (const [i, t] of targets.entries()) {
    let bankDisplayName = t.bankKey ?? "banco desconocido";
    if (t.bankKey) {
      const bank = await prisma.bankCatalog.findUnique({ where: { bankKey: t.bankKey } });
      if (bank) bankDisplayName = bank.displayName;
    }

    const syntheticText = [
      t.merchant ? `Comercio: ${t.merchant}` : null,
      t.description ? `Descripción: ${t.description}` : null,
      `Monto: ${t.currency} ${t.amount}`,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(`[${i + 1}/${targets.length}] ${t.merchant ?? t.description ?? t.id} (${t.currency} ${t.amount})`);

    try {
      const extracted = await extractTransactionFromEmail(syntheticText, bankDisplayName, categoryNames);
      const matched = extracted.suggestedCategory
        ? categoryByNormalizedName.get(normalizeText(extracted.suggestedCategory))
        : undefined;

      if (matched) {
        await prisma.transaction.update({ where: { id: t.id }, data: { categoryId: matched.id } });
        console.log(`  ✅ -> ${matched.name}`);
        categorized++;
      } else {
        console.log(`  ⚠️  Gemini no devolvió una categoría reconocible ("${extracted.suggestedCategory}")`);
        failed++;
      }
    } catch (err) {
      console.error(`  ❌ Error:`, err);
      failed++;
    }

    await sleep(SLEEP_MS);
  }

  console.log(`\n=== Resumen ===`);
  console.log(`Categorizadas: ${categorized}`);
  console.log(`Sin categorizar: ${failed}`);
  console.log(`Total procesadas: ${targets.length}`);
}

main()
  .catch((err) => console.error("Error:", err))
  .finally(() => prisma.$disconnect());
