import { Worker } from "bullmq";
import { redisConnection } from "./redisConnection";
import { prisma } from "../config/prisma";
import { syncOutlookAccount } from "../services/outlookSync";

export const emailSyncWorker = new Worker(
  "email-sync",
  async () => {
    const accounts = await prisma.emailAccount.findMany({
      where: { isActive: true, provider: "OUTLOOK" },
      include: { bankSenders: true },
    });

    console.log(`📬 Sincronizando ${accounts.length} cuenta(s) de correo...`);

    for (const account of accounts) {
      try {
        await syncOutlookAccount(account);
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
