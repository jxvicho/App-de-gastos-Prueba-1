import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { assertUnderLimit, getUserLimits } from "../services/planLimits";

export const goalsRouter = Router();
goalsRouter.use(requireAuth);

goalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const goals = await prisma.categoryGoal.findMany({ where: { userId: req.userId } });
    res.json(goals);
  })
);

const setSchema = z.object({
  categoryId: z.string().uuid(),
  currency: z.enum(["PEN", "USD"]).default("PEN"),
  amount: z.number().min(0).max(10_000_000), // 0 = quitar la meta
});

goalsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos de meta inválidos", 422);
    const { categoryId, currency, amount } = parsed.data;

    const category = await prisma.category.findFirst({ where: { id: categoryId, userId: req.userId } });
    if (!category) throw new AppError("Categoría no encontrada", 404);
    if (category.kind === "INCOME" && amount > 0) throw new AppError("Las metas son para categorías de gasto", 422);

    const where = { userId_categoryId_currency: { userId: req.userId!, categoryId, currency } };
    if (amount === 0) {
      await prisma.categoryGoal.deleteMany({ where: { userId: req.userId, categoryId, currency } });
      res.json({ categoryId, currency, amount: 0 });
      return;
    }
    // Cambiar el monto de una meta que ya existe siempre se permite; solo una meta NUEVA cuenta contra el tope.
    const current = await prisma.categoryGoal.findUnique({ where });
    if (!current) {
      const { goals: maxGoals } = await getUserLimits(req.userId!);
      const inUse = await prisma.categoryGoal.count({ where: { userId: req.userId, amount: { gt: 0 } } });
      assertUnderLimit(maxGoals, inUse, `El plan Gratis permite hasta ${maxGoals} metas (entre soles y dólares). Quita una o pasa a Pro para agregar más.`);
    }
    const goal = await prisma.categoryGoal.upsert({
      where,
      update: { amount },
      create: { userId: req.userId!, categoryId, currency, amount },
    });
    res.json(goal);
  })
);
