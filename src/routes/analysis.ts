import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { PLAN_FEATURES } from "../config/plans";
import { getEffectivePlan } from "../services/plans";
import { buildAnalysis } from "../services/analysis";

export const analysisRouter = Router();

const querySchema = z.object({ currency: z.enum(["PEN", "USD"]).optional() });

analysisRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError("currency debe ser PEN o USD", 422);
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { plan: true, planOverride: true, planOverrideUntil: true } });
    if (!user) throw new AppError("Usuario no encontrado", 404);
    const eff = await getEffectivePlan(user);
    if (!PLAN_FEATURES[eff.plan].analysis) {
      throw new AppError("La pestaña Análisis es parte del plan Pro.", 403, "PLAN_FEATURE");
    }
    res.json(await buildAnalysis(req.userId!, parsed.data.currency ?? "PEN"));
  })
);
