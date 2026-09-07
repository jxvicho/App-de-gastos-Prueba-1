import { prisma } from "../src/config/prisma";
import { syncOutlookAccount } from "../src/services/outlookSync";

async function main() {
  const account = await prisma.emailAccount.findFirst({
    where: { emailAddress: "j4v1ch0@hotmail.com" },
    include: { bankSenders: true },
  });

  if (!account) {
    console.error('No se encontró ninguna EmailAccount con emailAddress "j4v1ch0@hotmail.com"');
    return;
  }

  const before = await prisma.transaction.count({ where: { userId: account.userId } });

  await syncOutlookAccount(account);

  const after = await prisma.transaction.count({ where: { userId: account.userId } });

  console.log(`Transacciones creadas: ${after - before}`);
}

main()
  .catch((err) => {
    console.error("Error ejecutando testSync:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
