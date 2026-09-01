import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Evitamos crear múltiples instancias de PrismaClient en desarrollo
// (tsx watch recarga el módulo en cada cambio de archivo).
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV === "development") {
  global.__prisma = prisma;
}
