import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection";

export const weeklyReportQueue = new Queue("weekly-report", { connection: redisConnection });

export async function scheduleWeeklyReportRepeatable(): Promise<void> {
  await weeklyReportQueue.add(
    "send-all-weekly-reports",
    {},
    {
      // Todos los domingos a las 8:00pm hora de Lima.
      repeat: { pattern: "0 20 * * 0", tz: "America/Lima" },
      jobId: "weekly-report-repeatable",
      removeOnComplete: 20,
      removeOnFail: 50,
    }
  );
}
