import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection";

export const emailSyncQueue = new Queue("email-sync", { connection: redisConnection });

const TWO_MINUTES_MS = 2 * 60 * 1000;

export async function scheduleEmailSyncRepeatable(): Promise<void> {
  // Si el intervalo cambió desde la última vez que corrió el backend, hay
  // que borrar el repeatable viejo antes de agregar el nuevo — si no,
  // BullMQ los deja programados a los dos y el sync termina corriendo el
  // doble (uno cada 5 min, otro cada 2 min).
  const existing = await emailSyncQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === "sync-all-accounts") {
      await emailSyncQueue.removeRepeatableByKey(job.key);
    }
  }

  await emailSyncQueue.add(
    "sync-all-accounts",
    {},
    {
      repeat: { every: TWO_MINUTES_MS },
      jobId: "email-sync-repeatable",
      removeOnComplete: 20,
      removeOnFail: 50,
    }
  );
}
