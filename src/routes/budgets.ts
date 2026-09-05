import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const budgetsRouter = Router();

budgetsRouter.use(requireAuth);

function currentMonthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { start, end };
}

budgetsRouter.get(
  "/current",
  asyncHandler(async (req, res) => {
    const { start, end } = currentMonthBounds();
    const budget = await prisma.budget.findFirst({
      where: { userId: req.userId, scope: "PERSONAL", periodStart: start, periodEnd: end },
    });
    res.json(budget ?? { totalAmount: 0 });
  })
);

const setBudgetSchema = z.object({ totalAmount: z.number().min(0) });

budgetsRouter.put(
  "/current",
  asyncHandler(async (req, res) => {
    const parsed = setBudgetSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("totalAmount debe ser un número positivo", 422);

    const { start, end } = currentMonthBounds();
    const existing = await prisma.budget.findFirst({
      where: { userId: req.userId, scope: "PERSONAL", periodStart: start, periodEnd: end },
    });

    const budget = existing
      ? await prisma.budget.update({
          where: { id: existing.id },
          data: { totalAmount: parsed.data.totalAmount },
        })
      : await prisma.budget.create({
          data: {
            userId: req.userId!,
            scope: "PERSONAL",
            periodStart: start,
            periodEnd: end,
            totalAmount: parsed.data.totalAmount,
          },
        });

    res.json(budget);
  })
);
