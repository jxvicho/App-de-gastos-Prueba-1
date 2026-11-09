import { Worker } from "bullmq";
import { redisConnection } from "./redisConnection";
import { prisma } from "../config/prisma";
import { syncOutlookAccount } from "../services/outlookSync";
import { syncGmailAccount } from "../services/gmailSync";
import { isAccessRestricted } from "../services/billing";
import { getEffectivePlan } from "../services/plans";
import { PLAN_FEATURES } from "../config/plans";

export const emailSyncWorker = new Worker(
  "email-sync",
  async () => {
    const accounts = await prisma.emailAccount.findMany({
      where: { isActive: true },
      include: { bankSenders: true, user: true },
    });

    console.log(`📬 Sincronizando ${accounts.length} cuenta(s) de correo...`);

    // Usuarios en modo solo lectura (cobro pendiente): no se registran movimientos nuevos desde el correo.
    const restricted = new Map<string, boolean>();
    const planAllows = new Map<string, boolean>();
    for (const account of accounts) {
      try {
        if (!restricted.has(account.userId)) restricted.set(account.userId, await isAccessRestricted(account.userId));
        if (restricted.get(account.userId)) continue;
        // El plan Gratis no lee el correo (la cuenta queda conectada pero en pausa).
        if (!planAllows.has(account.userId)) planAllows.set(account.userId, PLAN_FEATURES[(await getEffectivePlan(account.user)).plan].emailSync);
        if (!planAllows.get(account.userId)) continue;
        if (account.provider === "GMAIL") await syncGmailAccount(account);
        else await syncOutlookAccount(account);
      } catch (err) {
        console.error(`❌ Error sincronizando ${account.emailAddress}:`, err);
      }
    }
  },
  { connection: redisConnection }
);

emailSyncWorker.on("failed", (job, err) => {
  console.error("❌ Job de sincronización de correo falló:", err.message);
});
