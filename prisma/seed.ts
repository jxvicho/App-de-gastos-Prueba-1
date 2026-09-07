import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Catálogo inicial de bancos/billeteras peruanas, con remitentes conocidos
// de notificaciones. Estos "senderEmails" hay que verificarlos y ampliarlos
// contra correos reales antes de producción — son un punto de partida.
const BANKS = [
  {
    bankKey: "bcp",
    displayName: "Banco de Crédito del Perú",
    senderEmails: ["notificaciones@notificabcp.com.pe", "bcpenlinea@viabcp.com"],
  },
  {
    bankKey: "interbank",
    displayName: "Interbank",
    senderEmails: ["notificaciones@interbank.pe"],
  },
  {
    bankKey: "bbva_pe",
    displayName: "BBVA Perú",
    senderEmails: ["procesos@bbva.com.pe", "notificaciones@bbva.pe"],
  },
  {
    bankKey: "scotiabank_pe",
    displayName: "Scotiabank Perú",
    senderEmails: ["notificaciones@scotiabank.com.pe"],
  },
  {
    bankKey: "yape",
    displayName: "Yape",
    senderEmails: ["notificaciones@yape.com.pe"],
  },
  {
    bankKey: "plin",
    displayName: "Plin",
    senderEmails: ["notificaciones@plin.pe"],
  },
  {
    bankKey: "banco_ripley",
    displayName: "Banco Ripley",
    senderEmails: ["notificaciones@bancoripley.com.pe"],
  },
  {
    bankKey: "banifit",
    displayName: "Banifit",
    senderEmails: ["notificaciones@banifit.pe"],
  },
];

async function main() {
  for (const bank of BANKS) {
    await prisma.bankCatalog.upsert({
      where: { bankKey: bank.bankKey },
      update: bank,
      create: bank,
    });
  }
  console.log(`✅ Seed completo: ${BANKS.length} bancos cargados en el catálogo`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
