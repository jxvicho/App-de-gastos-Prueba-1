import { Worker } from "bullmq";
import { redisConnection } from "./redisConnection";
import { prisma } from "../config/prisma";
import { sendWeeklyReportToUser } from "../services/weeklyReportSender";
import { currentWeekStart } from "../services/weeklyReportData";
import { getEffectivePlan } from "../services/plans";
import { PLAN_FEATURES } from "../config/plans";
import { claimOnce, releaseClaim } from "./dedupe";

export const weeklyReportWorker = new Worker(
  "weekly-report",
  async (job) => {
    const users = await prisma.user.findMany({ where: { phoneNumber: { not: null } } });
    console.log(`📊 Reporte semanal (trabajo ${job.id}): ${users.length} usuario(s) con teléfono...`);

    // Lunes 00:00 (Lima) de la semana actual hasta ahora mismo — el cron
    // corre justo el domingo 8pm, así que "ahora" es efectivamente esa hora.
    const weekStart = currentWeekStart();
    const weekEnd = new Date();

    const weekKey = weekStart.toISOString().slice(0, 10);
    let sent = 0;
    let skipped = 0;
    for (const user of users) {
      // Planes sin WhatsApp (Gratis) no reciben resúmenes por ahí.
      if (!PLAN_FEATURES[(await getEffectivePlan(user)).plan].whatsapp) continue;
      // Una sola vez por usuario y semana, aunque el trabajo se ejecute dos veces.
      const claim = `weekly-report:sent:${weekKey}:${user.id}`;
      if (!(await claimOnce(claim, 4 * 86_400))) {
        skipped++;
        continue;
      }
      try {
        await sendWeeklyReportToUser(user, weekStart, weekEnd);
        sent++;
      } catch (err) {
        await releaseClaim(claim); // falló: que un reintento pueda mandarlo
        console.error(`❌ Error mandando el reporte semanal a ${user.name}:`, err);
      }
    }
    console.log(`📊 Reporte semanal (trabajo ${job.id}): enviado a ${sent}, omitido por ya enviado ${skipped}.`);
  },
  // lockDuration amplio: con muchos usuarios el trabajo tarda y no debe considerarse "estancado" (se re-ejecutaría).
  { connection: redisConnection, lockDuration: 300_000 }
);

weeklyReportWorker.on("failed", (job, err) => {
  console.error("❌ Job de reporte semanal falló:", err.message);
});
