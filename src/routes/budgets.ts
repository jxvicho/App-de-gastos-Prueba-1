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

const CURRENCIES = ["PEN", "USD"] as const;
const currencyQuerySchema = z.object({ currency: z.enum(CURRENCIES).optional() });

budgetsRouter.get(
  "/current",
  asyncHandler(async (req, res) => {
    const parsed = currencyQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError("currency debe ser PEN o USD", 422);
    const currency = parsed.data.currency ?? "PEN";

    const { start, end } = currentMonthBounds();
    const budget = await prisma.budget.findFirst({
      where: { userId: req.userId, scope: "PERSONAL", periodStart: start, periodEnd: end, currency },
    });
    res.json(budget ?? { totalAmount: 0, currency });
  })
);

const setBudgetSchema = z.object({
  totalAmount: z.number().min(0),
  currency: z.enum(CURRENCIES).default("PEN"),
});

budgetsRouter.put(
  "/current",
  asyncHandler(async (req, res) => {
    const parsed = setBudgetSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos de presupuesto inválidos", 422);

    const { start, end } = currentMonthBounds();
    const existing = await prisma.budget.findFirst({
      where: { userId: req.userId, scope: "PERSONAL", periodStart: start, periodEnd: end, currency: parsed.data.currency },
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
            currency: parsed.data.currency,
          },
        });

    res.json(budget);
  })
);
