import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection";

export const dailyReportQueue = new Queue("daily-report", { connection: redisConnection });

/**
 * Corre al inicio de CADA hora (hora de Lima). El worker manda el reporte solo
 * a los usuarios cuya hora elegida coincide con la hora actual.
 */
export async function scheduleDailyReportRepeatable(): Promise<void> {
  await dailyReportQueue.add(
    "send-hourly-daily-reports",
    {},
    {
      repeat: { pattern: "0 * * * *", tz: "America/Lima" },
      jobId: "daily-report-repeatable",
      removeOnComplete: 24,
      removeOnFail: 50,
    }
  );
}
