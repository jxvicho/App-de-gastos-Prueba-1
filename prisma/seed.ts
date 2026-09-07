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
    bankKey: "banco_pichincha",
    displayName: "Banco Pichincha",
    senderEmails: ["notificaciones@pichincha.pe"],
  },
  {
    bankKey: "banco_falabella",
    displayName: "Banco Falabella",
    senderEmails: ["notificaciones@bancofalabella.pe"],
  },
  {
    bankKey: "agora",
    displayName: "Agora",
    senderEmails: ["notificaciones@agora.pe"],
  },
  {
    bankKey: "sip",
    displayName: "SIP",
    senderEmails: ["notificaciones@sip.pe"],
  },
  {
    bankKey: "diners",
    displayName: "Diners",
    senderEmails: ["notificaciones@dinersclub.com.pe"],
  },
  {
    bankKey: "io",
    displayName: "IO",
    senderEmails: ["notificaciones@io.pe"],
  },
  {
    bankKey: "banbif",
    displayName: "BanBif",
    senderEmails: ["notificaciones@banbif.com.pe"],
  },
  {
    bankKey: "banco_nacion",
    displayName: "Banco de la Nación",
    senderEmails: ["notificaciones@bn.com.pe"],
  },
  {
    bankKey: "lemon_cash",
    displayName: "Lemon Cash",
    senderEmails: ["notificaciones@lemon.me"],
  },
];

// Bancos que salieron del catálogo definitivo. Los desactivamos en vez de
// borrarlos, porque no hay FK entre BankSender y BankCatalog: si alguna
// cuenta ya tiene un BankSender apuntando a uno de estos bankKey, un delete
// lo dejaría como referencia suelta.
const DEACTIVATED_BANK_KEYS = ["banifit", "banco_ripley", "plin"];

async function main() {
  for (const bank of BANKS) {
    await prisma.bankCatalog.upsert({
      where: { bankKey: bank.bankKey },
      update: bank,
      create: bank,
    });
  }

  await prisma.bankCatalog.updateMany({
    where: { bankKey: { in: DEACTIVATED_BANK_KEYS } },
    data: { isActive: false },
  });

  console.log(`✅ Seed completo: ${BANKS.length} bancos cargados en el catálogo`);
  console.log(`🚫 Bancos desactivados: ${DEACTIVATED_BANK_KEYS.join(", ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
