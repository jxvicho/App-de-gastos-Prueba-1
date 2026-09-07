import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection";

export const emailSyncQueue = new Queue("email-sync", { connection: redisConnection });

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export async function scheduleEmailSyncRepeatable(): Promise<void> {
  await emailSyncQueue.add(
    "sync-all-accounts",
    {},
    {
      repeat: { every: FIVE_MINUTES_MS },
      jobId: "email-sync-repeatable",
      removeOnComplete: 20,
      removeOnFail: 50,
    }
  );
}
