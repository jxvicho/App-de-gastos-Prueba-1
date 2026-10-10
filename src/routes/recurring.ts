import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { detectRecurringPayments, merchantKeyOf } from "../services/recurringDetect";

export const recurringRouter = Router();
recurringRouter.use(requireAuth);

const CURRENCIES = ["PEN", "USD"] as const;

// Lista los pagos fijos (y detecta los nuevos al consultar).
recurringRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await detectRecurringPayments(req.userId!);
    const rows = await prisma.recurringPayment.findMany({
      where: { userId: req.userId, ignored: false },
      orderBy: [{ dayOfMonth: "asc" }, { merchant: "asc" }],
    });
    res.json(rows);
  })
);

const createSchema = z.object({
  merchant: z.string().trim().min(2).max(60),
  amount: z.number().positive().max(1_000_000),
  currency: z.enum(CURRENCIES).default("PEN"),
  dayOfMonth: z.number().int().min(1).max(31),
});

recurringRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const merchantKey = merchantKeyOf(parsed.data.merchant) || parsed.data.merchant.toLowerCase();
    const existing = await prisma.recurringPayment.findUnique({
      where: { userId_merchantKey_currency: { userId: req.userId!, merchantKey, currency: parsed.data.currency } },
    });
    if (existing && !existing.ignored) throw new AppError("Ya tienes un pago recurrente con ese nombre", 409);

    const data = { ...parsed.data, merchantKey, source: "MANUAL", ignored: false, isActive: true };
    const row = existing
      ? await prisma.recurringPayment.update({ where: { id: existing.id }, data })
      : await prisma.recurringPayment.create({ data: { ...data, userId: req.userId! } });
    res.status(201).json(row);
  })
);

const patchSchema = z.object({
  merchant: z.string().trim().min(2).max(60).optional(),
  amount: z.number().positive().max(1_000_000).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  isActive: z.boolean().optional(),
});

recurringRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const row = await prisma.recurringPayment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!row) throw new AppError("Pago recurrente no encontrado", 404);
    const updated = await prisma.recurringPayment.update({
      where: { id: row.id },
      data: { ...parsed.data, source: "MANUAL" }, // editado a mano: la detección ya no lo pisa
    });
    res.json(updated);
  })
);

// "Eliminar" = ignorar: así la detección automática no lo vuelve a proponer.
recurringRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await prisma.recurringPayment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!row) throw new AppError("Pago recurrente no encontrado", 404);
    await prisma.recurringPayment.update({ where: { id: row.id }, data: { ignored: true, isActive: false } });
    res.status(204).end();
  })
);
