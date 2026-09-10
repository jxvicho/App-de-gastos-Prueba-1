import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const transactionsRouter = Router();

transactionsRouter.use(requireAuth);

const STATUS_VALUES = ["PENDING_CONFIRMATION", "CONFIRMED", "REJECTED", "AUTO_CONFIRMED"] as const;

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  categoryId: z.string().uuid().optional(),
  // Uno o varios separados por coma, ej. "CONFIRMED,AUTO_CONFIRMED" — el
  // dashboard los pide así para no mezclar movimientos reales con
  // PENDING_CONFIRMATION/REJECTED, que antes se colaban en la tabla y en
  // los totales/gráficos por no filtrarse en absoluto.
  status: z.string().optional(),
  // Uno o varios separados por coma, ej. "PEN,USD" — soles y dólares nunca
  // se suman en un total, pero listarlos juntos en la tabla es correcto
  // porque cada fila muestra su propio monto con su propio símbolo.
  currency: z.string().optional(),
});

transactionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError("Parámetros de filtro inválidos", 422);
    const { from, to, categoryId, status, currency } = parsed.data;

    let statusFilter: (typeof STATUS_VALUES)[number][] | undefined;
    if (status) {
      const values = status.split(",").map((s) => s.trim());
      const invalid = values.find((v) => !STATUS_VALUES.includes(v as (typeof STATUS_VALUES)[number]));
      if (invalid) throw new AppError(`status inválido: "${invalid}"`, 422);
      statusFilter = values as (typeof STATUS_VALUES)[number][];
    }

    const currencyFilter = currency ? currency.split(",").map((c) => c.trim()) : undefined;

    const transactions = await prisma.transaction.findMany({
      where: {
        userId: req.userId,
        categoryId,
        status: statusFilter ? { in: statusFilter } : undefined,
        currency: currencyFilter ? { in: currencyFilter } : undefined,
        deletedAt: null,
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

const changeCategorySchema = z.object({ categoryId: z.string().uuid() });

transactionsRouter.patch(
  "/:id/category",
  asyncHandler(async (req, res) => {
    const parsed = changeCategorySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("categoryId inválido", 422);

    const transaction = await prisma.transaction.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!transaction) throw new AppError("Transacción no encontrada", 404);

    const category = await prisma.category.findFirst({
      where: { id: parsed.data.categoryId, userId: req.userId },
    });
    if (!category) throw new AppError("Categoría no encontrada", 404);

    // La categoría "Ingresos" es especial: asignar un movimiento a ella lo
    // reclasifica automáticamente como ingreso, y sacarlo de ahí lo vuelve
    // a clasificar como egreso.
    const newType = category.name === "Ingresos" ? "INCOME" : "EXPENSE";

    const updated = await prisma.transaction.update({
      where: { id: transaction.id },
      data: { categoryId: category.id, type: newType },
    });

    res.json(updated);
  })
);