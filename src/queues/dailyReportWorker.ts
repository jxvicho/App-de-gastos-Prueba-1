import { Worker } from "bullmq";
import { redisConnection } from "./redisConnection";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { sendDailyReportToUser } from "../services/dailyReportSender";
import { currentLimaHour } from "../services/weeklyReportData";
import { getEffectivePlan } from "../services/plans";

export const dailyReportWorker = new Worker(
  "daily-report",
  async () => {
    const hour = currentLimaHour();
    // Domingo: si está activada la fusión, el semanal (20:00) reemplaza al diario.
    const isSundayLima = new Date().toLocaleDateString("en-US", { timeZone: "America/Lima", weekday: "short" }) === "Sun";
    if (isSundayLima && env.SUNDAY_MERGE_DAILY_INTO_WEEKLY) return;
    const candidates = await prisma.user.findMany({
      where: { whatsappOptIn: true, phoneNumber: { not: null } },
    });
    if (candidates.length === 0) return;
    let sent = 0;
    for (const user of candidates) {
      try {
        const eff = await getEffectivePlan(user);
        // El resumen diario es de Pro y Unlimited (Básico solo recibe el semanal), a la hora que eligieron.
        if (eff.plan === "BASIC" || user.dailySummaryHour !== hour) continue;
        // Solo Unlimited puede apagarlo; en los demás planes va siempre activo.
        if (eff.plan === "UNLIMITED" && !user.dailySummaryEnabled) continue;
        sent++;
        await sendDailyReportToUser(user);
      } catch (err) {
        console.error(`❌ Error mandando el reporte diario a ${user.name}:`, err);
      }
    }
    if (sent > 0) console.log(`📅 Reporte diario de las ${hour}:00 procesado para ${sent} usuario(s).`);
  },
  { connection: redisConnection }
);

dailyReportWorker.on("failed", (job, err) => {
  console.error("❌ Job de reporte diario falló:", err.message);
});
