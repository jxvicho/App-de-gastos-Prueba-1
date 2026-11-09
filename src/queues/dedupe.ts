import { redisConnection } from "./redisConnection";

/**
 * Candado de "una sola vez": devuelve true solo la primera vez que se pide esta clave dentro de su TTL.
 * Sirve para que un envío programado (reporte semanal/diario) NUNCA salga dos veces al mismo usuario,
 * aunque el trabajo se ejecute de nuevo (reinicio del servidor a mitad del envío, trabajo "estancado",
 * una programación repetida que quedó en Redis, etc.).
 */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  return (await redisConnection.set(key, "1", "EX", ttlSeconds, "NX")) === "OK";
}

/** Libera el candado (si el envío falló y se quiere permitir un reintento). */
export async function releaseClaim(key: string): Promise<void> {
  await redisConnection.del(key);
}
