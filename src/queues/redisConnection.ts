import IORedis from "ioredis";
import { env } from "../config/env";

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
  console.error("❌ Error de conexión a Redis:", err.message);
});
