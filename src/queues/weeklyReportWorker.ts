import { Worker } from "bullmq";
import { redisConnection } from "./redisConnection";
import { prisma } from "../config/prisma";
import { sendWeeklyReportToUser } from "../services/weeklyReportSender";
import { currentWeekStart } from "../services/weeklyReportData";

export const weeklyReportWorker = new Worker(
  "weekly-report",
  async () => {
    const users = await prisma.user.findMany({ where: { phoneNumber: { not: null } } });
    console.log(`📊 Mandando el reporte semanal a ${users.length} usuario(s)...`);

    // Lunes 00:00 (Lima) de la semana actual hasta ahora mismo — el cron
    // corre justo el domingo 8pm, así que "ahora" es efectivamente esa hora.
    const weekStart = currentWeekStart();
    const weekEnd = new Date();

    for (const user of users) {
      try {
        await sendWeeklyReportToUser(user, weekStart, weekEnd);
      } catch (err) {
        console.error(`❌ Error mandando el reporte semanal a ${user.name}:`, err);
      }
    }
  },
  { connection: redisConnection }
);

weeklyReportWorker.on("failed", (job, err) => {
  console.error("❌ Job de reporte semanal falló:", err.message);
});
