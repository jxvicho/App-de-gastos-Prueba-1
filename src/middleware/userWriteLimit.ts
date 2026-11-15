import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { PLAN_FEATURES } from "../config/plans";
import { getEffectivePlan } from "../services/plans";
import { asyncHandler } from "./asyncHandler";

/**
 * Tope de escrituras (POST/PUT/PATCH/DELETE) por usuario y por minuto, según su plan. Complementa el tope por IP:
 * una IP compartida (oficina, red móvil) no castiga a los demás, y quien cambia de IP no se salta el límite.
 * En memoria (una sola instancia); el plan se cachea 60 s para no consultar la base en cada petición.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const planCache = new Map<string, { writes: number; until: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  for (const [k, c] of planCache) if (c.until <= now) planCache.delete(k);
}, 60_000).unref();

export const userWriteLimit = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || !req.userId) return next();
  const now = Date.now();
  let c = planCache.get(req.userId);
  if (!c || c.until <= now) {
    const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { plan: true, planOverride: true, planOverrideUntil: true } });
    const plan = u ? (await getEffectivePlan(u)).plan : "FREE";
    c = { writes: PLAN_FEATURES[plan].writesPerMinute, until: now + 60_000 };
    planCache.set(req.userId, c);
  }
  let b = buckets.get(req.userId);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + 60_000 };
    buckets.set(req.userId, b);
  }
  b.count += 1;
  if (b.count > c.writes) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
    return res.status(429).json({ error: "Estás haciendo cambios demasiado rápido. Espera un momento e inténtalo de nuevo.", code: "RATE_LIMIT" });
  }
  next();
});
