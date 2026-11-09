import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection";

export const weeklyReportQueue = new Queue("weekly-report", { connection: redisConnection });

const JOB_NAME = "send-all-weekly-reports";
const JOB_ID = "weekly-report-repeatable";

/**
 * Deja UNA sola programación del reporte semanal. Si en Redis quedó alguna repetida (de una versión anterior,
 * con otro patrón u otra zona horaria), el reporte saldría dos veces; aquí se eliminan las que sobren.
 */
async function removeStaleRepeatables(): Promise<void> {
  const repeatables = await weeklyReportQueue.getRepeatableJobs();
  const mine = repeatables.filter((r) => r.name === JOB_NAME);
  const keep = mine.find((r) => r.pattern === "0 20 * * 0" && r.tz === "America/Lima" && r.id === JOB_ID);
  for (const r of mine) {
    if (r === keep) continue;
    await weeklyReportQueue.removeRepeatableByKey(r.key);
    console.warn(`📊 Reporte semanal: se eliminó una programación repetida (${r.key}).`);
  }
}

export async function scheduleWeeklyReportRepeatable(): Promise<void> {
  await removeStaleRepeatables();
  await weeklyReportQueue.add(
    JOB_NAME,
    {},
    {
      // Todos los domingos a las 8:00pm hora de Lima.
      repeat: { pattern: "0 20 * * 0", tz: "America/Lima" },
      jobId: JOB_ID,
      removeOnComplete: 20,
      removeOnFail: 50,
    }
  );
}
