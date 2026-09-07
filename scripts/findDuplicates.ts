import { prisma } from "../src/config/prisma";

async function main() {
  const account = await prisma.emailAccount.findFirst({
    where: { emailAddress: "j4v1ch0@hotmail.com" },
  });
  if (!account) {
    console.error('No se encontró ninguna EmailAccount con emailAddress "j4v1ch0@hotmail.com"');
    return;
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId: account.userId },
    orderBy: { occurredAt: "asc" },
  });

  const groups = new Map<string, typeof transactions>();
  for (const t of transactions) {
    const key = `${t.merchant ?? ""}|${t.amount.toString()}|${t.occurredAt.toISOString()}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const duplicateGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

  console.log(`Total de transacciones: ${transactions.length}`);
  console.log(`Grupos duplicados encontrados (mismo merchant + amount + occurredAt): ${duplicateGroups.length}`);
  console.log("");

  duplicateGroups.forEach(([key, arr], i) => {
    console.log(`=== Grupo ${i + 1}: ${key} ===`);
    arr.forEach((t) => {
      console.log(`  id: ${t.id}`);
      console.log(`  rawEmailId: ${t.rawEmailId}`);
      console.log(`  createdAt: ${t.createdAt.toISOString()}`);
      console.log(`  extractionMeta: ${JSON.stringify(t.extractionMeta)}`);
      console.log("  ---");
    });
    const rawIds = arr.map((t) => t.rawEmailId);
    const uniqueRawIds = new Set(rawIds);
    console.log(
      uniqueRawIds.size === 1
        ? "  => MISMO rawEmailId repetido (bug: el mismo correo se procesó más de una vez)"
        : "  => rawEmailId DISTINTOS (dos correos reales distintos del banco para el mismo movimiento)"
    );
    console.log("");
  });
}

main()
  .catch((err) => {
    console.error("Error ejecutando findDuplicates:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
