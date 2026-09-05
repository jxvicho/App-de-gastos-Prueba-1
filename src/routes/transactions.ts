import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const transactionsRouter = Router();

transactionsRouter.use(requireAuth);

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(["PENDING_CONFIRMATION", "CONFIRMED", "REJECTED", "AUTO_CONFIRMED"]).optional(),
});

transactionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError("Parámetros de filtro inválidos", 422);
    const { from, to, categoryId, status } = parsed.data;

    const transactions = await prisma.transaction.findMany({
      where: {
        userId: req.userId,
        categoryId,
        status,
        occurredAt: {
          gte: from ? new Date(from) : undefined,
          lte: to ? new Date(to) : undefined,
        },
      },
      include: { category: true, accountCard: true },
      orderBy: { occurredAt: "desc" },
    });

    res.json(transactions);
  })
);

const createTransactionSchema = z.object({
  type: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE"),
  amount: z.number().positive(),
  currency: z.string().default("PEN"),
  merchant: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  accountCardId: z.string().uuid().optional(),
  occurredAt: z.string().datetime(),
});

transactionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createTransactionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 422);

    const transaction = await prisma.transaction.create({
      data: {
        ...parsed.data,
        occurredAt: new Date(parsed.data.occurredAt),
        userId: req.userId!,
        source: "DASHBOARD_MANUAL",
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    });

    res.status(201).json(transaction);
  })
);

const decisionSchema = z.object({ decision: z.enum(["CONFIRMED", "REJECTED"]) });

transactionsRouter.patch(
  "/:id/decision",
  asyncHandler(async (req, res) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("decision debe ser CONFIRMED o REJECTED", 422);

    const transaction = await prisma.transaction.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!transaction) throw new AppError("Transacción no encontrada", 404);

    const updated = await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: parsed.data.decision,
        confirmedAt: parsed.data.decision === "CONFIRMED" ? new Date() : null,
      },
    });

    res.json(updated);
  })
);