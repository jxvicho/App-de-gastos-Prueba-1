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
    where: { userId: account.userId, rawEmailId: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  const seen = new Map<string, string>(); // rawEmailId -> id de la fila que se conserva (la más antigua)
  const toDelete: string[] = [];

  for (const t of transactions) {
    const key = t.rawEmailId as string;
    if (seen.has(key)) {
      toDelete.push(t.id);
    } else {
      seen.set(key, t.id);
    }
  }

  console.log(`Transacciones con rawEmailId: ${transactions.length}`);
  console.log(`Filas duplicadas a eliminar (se conserva la más antigua por rawEmailId): ${toDelete.length}`);
  toDelete.forEach((id) => console.log(`  - ${id}`));

  if (toDelete.length > 0) {
    const result = await prisma.transaction.deleteMany({ where: { id: { in: toDelete } } });
    console.log(`Eliminadas: ${result.count}`);
  } else {
    console.log("Nada que eliminar.");
  }
}

main()
  .catch((err) => {
    console.error("Error ejecutando removeDuplicates:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
