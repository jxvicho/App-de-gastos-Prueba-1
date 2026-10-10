import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";

export const debtsRouter = Router();
debtsRouter.use(requireAuth);

const DIRECTIONS = ["RECEIVABLE", "PAYABLE"] as const;

function serialize(d: any) {
  const amount = Number(d.amount);
  const paid = (d.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0);
  return {
    id: d.id,
    direction: d.direction,
    counterparty: d.counterparty,
    concept: d.concept,
    amount,
    currency: d.currency,
    dueDate: d.dueDate,
    phone: d.phone,
    settledAt: d.settledAt,
    createdAt: d.createdAt,
    paid: Math.round(paid * 100) / 100,
    remaining: Math.max(0, Math.round((amount - paid) * 100) / 100),
    payments: (d.payments ?? []).map((p: any) => ({ id: p.id, amount: Number(p.amount), paidAt: p.paidAt, note: p.note })),
  };
}

async function loadOwned(userId: string, id: string) {
  const d = await prisma.debt.findFirst({ where: { id, userId }, include: { payments: { orderBy: { paidAt: "asc" } } } });
  if (!d) throw new AppError("Deuda no encontrada", 404);
  return d;
}

debtsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await prisma.debt.findMany({
      where: { userId: req.userId },
      include: { payments: { orderBy: { paidAt: "asc" } } },
      orderBy: [{ settledAt: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    });
    res.json(rows.map(serialize));
  })
);

const dueSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const phoneSchema = z.string().trim().max(20).nullable().optional();

const createSchema = z.object({
  direction: z.enum(DIRECTIONS),
  counterparty: z.string().trim().min(2).max(60),
  concept: z.string().trim().max(120).nullable().optional(),
  amount: z.number().positive().max(10_000_000),
  currency: z.enum(["PEN", "USD"]).default("PEN"),
  dueDate: dueSchema,
  phone: phoneSchema,
});

const toDate = (s?: string | null) => (s ? new Date(s + "T12:00:00-05:00") : null);

debtsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) throw new AppError(p.error.issues[0]?.message ?? "Datos inválidos", 422);
    const d = await prisma.debt.create({
      data: {
        userId: req.userId!,
        direction: p.data.direction,
        counterparty: p.data.counterparty,
        concept: p.data.concept || null,
        amount: p.data.amount,
        currency: p.data.currency,
        dueDate: toDate(p.data.dueDate),
        phone: p.data.phone || null,
      },
      include: { payments: true },
    });
    res.status(201).json(serialize(d));
  })
);

const patchSchema = z.object({
  counterparty: z.string().trim().min(2).max(60).optional(),
  concept: z.string().trim().max(120).nullable().optional(),
  amount: z.number().positive().max(10_000_000).optional(),
  dueDate: dueSchema,
  phone: phoneSchema,
  settled: z.boolean().optional(), // true = saldada (o reabierta con false)
});

debtsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const p = patchSchema.safeParse(req.body);
    if (!p.success) throw new AppError(p.error.issues[0]?.message ?? "Datos inválidos", 422);
    const cur = await loadOwned(req.userId!, req.params.id);
    const { dueDate, settled, ...rest } = p.data;
    const data: any = { ...rest };
    if (dueDate !== undefined) data.dueDate = toDate(dueDate);
    if (settled !== undefined) data.settledAt = settled ? new Date() : null;
    await prisma.debt.update({ where: { id: cur.id }, data });
    res.json(serialize(await loadOwned(req.userId!, cur.id)));
  })
);

debtsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const cur = await loadOwned(req.userId!, req.params.id);
    await prisma.debt.delete({ where: { id: cur.id } });
    res.status(204).end();
  })
);

const paymentSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  note: z.string().trim().max(120).nullable().optional(),
});

// Registra un abono. Si cubre el saldo, la deuda queda saldada sola.
debtsRouter.post(
  "/:id/payments",
  asyncHandler(async (req, res) => {
    const p = paymentSchema.safeParse(req.body);
    if (!p.success) throw new AppError(p.error.issues[0]?.message ?? "Monto inválido", 422);
    const cur = serialize(await loadOwned(req.userId!, req.params.id));
    if (cur.settledAt) throw new AppError("Esta deuda ya está saldada", 409);
    if (p.data.amount > cur.remaining + 0.001) throw new AppError("El abono supera el saldo pendiente", 422);
    await prisma.debtPayment.create({ data: { debtId: cur.id, amount: p.data.amount, note: p.data.note || null } });
    const after = serialize(await loadOwned(req.userId!, cur.id));
    if (after.remaining <= 0.001) await prisma.debt.update({ where: { id: cur.id }, data: { settledAt: new Date() } });
    res.status(201).json(serialize(await loadOwned(req.userId!, cur.id)));
  })
);

debtsRouter.delete(
  "/:id/payments/:pid",
  asyncHandler(async (req, res) => {
    const cur = await loadOwned(req.userId!, req.params.id);
    await prisma.debtPayment.deleteMany({ where: { id: req.params.pid, debtId: cur.id } });
    await prisma.debt.update({ where: { id: cur.id }, data: { settledAt: null } });
    const after = serialize(await loadOwned(req.userId!, cur.id));
    if (after.remaining <= 0.001) await prisma.debt.update({ where: { id: cur.id }, data: { settledAt: new Date() } });
    res.json(serialize(await loadOwned(req.userId!, cur.id)));
  })
);
