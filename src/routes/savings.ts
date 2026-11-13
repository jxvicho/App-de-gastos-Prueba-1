import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { PLAN_FEATURES } from "../config/plans";
import { getEffectivePlan } from "../services/plans";
import { loadSavingsGoals } from "../services/analysis";

export const savingsRouter = Router();

async function assertAnalysisPlan(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true, planOverride: true, planOverrideUntil: true } });
  if (!user) throw new AppError("Usuario no encontrado", 404);
  if (!PLAN_FEATURES[(await getEffectivePlan(user)).plan].analysis) throw new AppError("Las metas de ahorro son parte del plan Pro.", 403, "PLAN_FEATURE");
}

const MAX_GOALS = 12;
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Fecha inválida");

const bodySchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre a la meta").max(40),
  currency: z.enum(["PEN", "USD"]).default("PEN"),
  targetAmount: z.number().positive("El monto debe ser mayor a 0").max(100_000_000),
  initialSaved: z.number().min(0).max(100_000_000).default(0),
  mode: z.enum(["DATE", "AMOUNT"]).default("DATE"),
  targetMonth: month.nullable().optional(),
  monthlyAmount: z.number().positive().max(100_000_000).nullable().optional(),
});

savingsRouter.get("/", asyncHandler(async (req, res) => {
  await assertAnalysisPlan(req.userId!);
  res.json(await loadSavingsGoals(req.userId!));
}));

savingsRouter.post("/", asyncHandler(async (req, res) => {
  await assertAnalysisPlan(req.userId!);
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
  const d = parsed.data;
  if (d.mode === "DATE" && !d.targetMonth) throw new AppError("Elige para qué mes quieres llegar", 422);
  if (d.mode === "AMOUNT" && !d.monthlyAmount) throw new AppError("Indica cuánto vas a apartar al mes", 422);
  if ((await prisma.savingsGoal.count({ where: { userId: req.userId } })) >= MAX_GOALS) throw new AppError(`Puedes tener hasta ${MAX_GOALS} metas de ahorro.`, 403, "PLAN_LIMIT");
  const g = await prisma.savingsGoal.create({
    data: { userId: req.userId!, name: d.name, currency: d.currency, targetAmount: d.targetAmount, initialSaved: d.initialSaved, mode: d.mode, targetMonth: d.targetMonth ?? null, monthlyAmount: d.monthlyAmount ?? null },
  });
  res.status(201).json({ id: g.id });
}));

const patchSchema = bodySchema.partial().omit({ currency: true });

savingsRouter.patch("/:id", asyncHandler(async (req, res) => {
  await assertAnalysisPlan(req.userId!);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
  const owned = await prisma.savingsGoal.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!owned) throw new AppError("Meta no encontrada", 404);
  const d = parsed.data;
  await prisma.savingsGoal.update({
    where: { id: owned.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.targetAmount !== undefined ? { targetAmount: d.targetAmount } : {}),
      ...(d.initialSaved !== undefined ? { initialSaved: d.initialSaved } : {}),
      ...(d.mode !== undefined ? { mode: d.mode } : {}),
      ...(d.targetMonth !== undefined ? { targetMonth: d.targetMonth } : {}),
      ...(d.monthlyAmount !== undefined ? { monthlyAmount: d.monthlyAmount } : {}),
    },
  });
  res.json({ ok: true });
}));

savingsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const owned = await prisma.savingsGoal.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!owned) throw new AppError("Meta no encontrada", 404);
  await prisma.savingsGoal.delete({ where: { id: owned.id } });
  res.status(204).end();
}));

const contribSchema = z.object({ amount: z.number().positive("El aporte debe ser mayor a 0").max(100_000_000) });

savingsRouter.post("/:id/contributions", asyncHandler(async (req, res) => {
  await assertAnalysisPlan(req.userId!);
  const parsed = contribSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
  const owned = await prisma.savingsGoal.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!owned) throw new AppError("Meta no encontrada", 404);
  await prisma.savingsContribution.create({ data: { goalId: owned.id, amount: parsed.data.amount } });
  res.status(201).json({ ok: true });
}));
