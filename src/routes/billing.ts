import crypto from "crypto";
import { Router } from "express";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { processCulqiEvent } from "../services/billing";

/**
 * Webhook de Culqi. Culqi no firma los eventos, así que la URL lleva un secreto (CULQI_WEBHOOK_SECRET):
 *   https://<dominio>/api/billing/culqi-webhook/<secreto>
 * y además cada evento se verifica consultando el recurso a la API de Culqi (ver processCulqiEvent).
 */
export const billingRouter = Router();

function secretMatches(given: string): boolean {
  const expected = env.CULQI_WEBHOOK_SECRET;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

billingRouter.post(
  "/culqi-webhook/:secret",
  asyncHandler(async (req, res) => {
    if (!env.CULQI_WEBHOOK_SECRET) throw new AppError("Webhook no configurado", 503);
    if (!secretMatches(String(req.params.secret))) throw new AppError("No autorizado", 401);
    const result = await processCulqiEvent((req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true, ...result });
  })
);
