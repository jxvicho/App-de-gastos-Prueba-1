import { Router } from "express";
import { prisma } from "../config/prisma";
import { redisConnection } from "../queues/redisConnection";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { env } from "../config/env";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// Si el último sync de correo es más viejo que esto, avisamos (el worker corre
// cada 2 minutos, así que 10 minutos sin novedad ya es raro).
const EMAIL_SYNC_STALE_MS = 10 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// ¿Responde el túnel público? Consultamos nuestro propio /api/health por la URL pública
// (lo mismo que haría Meta). Se cachea 30 s para no pegarle en cada refresco del dashboard.
let tunnelCache: { at: number; value: { configured: boolean; up: boolean } } | null = null;
async function checkTunnel(): Promise<{ configured: boolean; up: boolean }> {
  const raw = (env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  let host = "";
  try { host = new URL(raw).hostname; } catch { /* vacío o inválido */ }
  if (!host || host === "localhost" || host === "127.0.0.1") return { configured: false, up: false };
  if (tunnelCache && Date.now() - tunnelCache.at < 30_000) return tunnelCache.value;
  let up = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(raw + "/api/health", { signal: ctrl.signal, headers: { "ngrok-skip-browser-warning": "1" } });
    clearTimeout(t);
    up = r.ok && ((await r.json()) as { status?: string }).status === "ok";
  } catch { up = false; }
  tunnelCache = { at: Date.now(), value: { configured: true, up } };
  return tunnelCache.value;
}

/**
 * Estado real del sistema para la pastilla "Servidor Gastia operativo" del
 * dashboard. Requiere sesión: no expone nada a quien no esté logueado.
 *   level: "ok" | "warn" | "error"
 */
healthRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    let db = true;
    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 3000);
    } catch {
      db = false;
    }

    let redis = true;
    try {
      await withTimeout(redisConnection.ping(), 2000);
    } catch {
      redis = false;
    }

    let emailAccounts = 0;
    let lastSyncedAt: Date | null = null;
    if (db) {
      const accounts = await prisma.emailAccount.findMany({
        where: { userId: req.userId, isActive: true },
        select: { lastSyncedAt: true },
      });
      emailAccounts = accounts.length;
      for (const a of accounts) {
        if (a.lastSyncedAt && (!lastSyncedAt || a.lastSyncedAt > lastSyncedAt)) lastSyncedAt = a.lastSyncedAt;
      }
    }

    const emailStale =
      emailAccounts > 0 && (!lastSyncedAt || Date.now() - lastSyncedAt.getTime() > EMAIL_SYNC_STALE_MS);

    const tunnel = await checkTunnel();

    let level: "ok" | "warn" | "error" = "ok";
    if (!db || !redis) level = "error";
    else if (emailStale || (tunnel.configured && !tunnel.up)) level = "warn";

    res.json({
      level,
      db,
      redis,
      email: { accounts: emailAccounts, lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null, stale: emailStale },
      tunnel,
      timestamp: new Date().toISOString(),
    });
  })
);
