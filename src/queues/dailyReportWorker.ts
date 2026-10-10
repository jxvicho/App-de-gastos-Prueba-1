import { Worker } from "bullmq";
import { redisConnection } from "./redisConnection";
import { prisma } from "../config/prisma";
import { sendDailyReportToUser } from "../services/dailyReportSender";
import { currentLimaHour } from "../services/weeklyReportData";
import { getEffectivePlan } from "../services/plans";

export const dailyReportWorker = new Worker(
  "daily-report",
  async () => {
    const hour = currentLimaHour();
    const users = await prisma.user.findMany({
      where: { whatsappOptIn: true, dailySummaryHour: hour, phoneNumber: { not: null } },
    });
    if (users.length === 0) return;
    console.log(`📅 Reporte diario de las ${hour}:00: ${users.length} usuario(s) a esta hora...`);
    for (const user of users) {
      try {
        // Solo el plan especial (UNLIMITED) puede apagarlo; en los demás planes va siempre activo.
        const eff = await getEffectivePlan(user);
        if (eff.plan === "UNLIMITED" && !user.dailySummaryEnabled) continue;
        await sendDailyReportToUser(user);
      } catch (err) {
        console.error(`❌ Error mandando el reporte diario a ${user.name}:`, err);
      }
    }
  },
  { connection: redisConnection }
);

dailyReportWorker.on("failed", (job, err) => {
  console.error("❌ Job de reporte diario falló:", err.message);
});
