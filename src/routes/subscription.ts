import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { PLAN_LABELS, PLAN_PRICE_PEN, TRIAL_DAYS } from "../config/plans";
import { getEffectivePlan } from "../services/plans";

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth);

const DAY_MS = 86_400_000;

/**
 * Estado de la suscripción para "Plan y suscripción". Todavía no hay pasarela:
 * `paymentsEnabled` es false y el método de pago es solo informativo.
 */
subscriptionRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: { plan: true, planOverride: true, planOverrideUntil: true, email: true, name: true, subscription: true },
    });
    const eff = await getEffectivePlan(user);
    const sub = user.subscription;
    const now = Date.now();

    const trialEnds = sub?.trialEndsAt ?? null;
    const trialActive = !!trialEnds && sub?.status === "TRIALING" && trialEnds.getTime() > now;
    const trialDaysLeft = trialActive ? Math.max(0, Math.ceil((trialEnds!.getTime() - now) / DAY_MS)) : 0;
    const trialTotalDays =
      sub?.trialStartedAt && trialEnds ? Math.max(1, Math.round((trialEnds.getTime() - sub.trialStartedAt.getTime()) / DAY_MS)) : TRIAL_DAYS;

    const next = sub?.currentPeriodEnd ?? (trialActive ? trialEnds : null);

    res.json({
      plan: eff.plan,
      planLabel: PLAN_LABELS[eff.plan],
      source: eff.source, // plan | promo | override
      priceMonthly: PLAN_PRICE_PEN[eff.plan],
      currency: "PEN",
      status: sub?.status ?? null,
      trial: sub?.trialEndsAt
        ? { active: trialActive, endsAt: trialEnds, daysLeft: trialDaysLeft, totalDays: trialTotalDays }
        : null,
      billing: {
        nextBillingDate: next,
        billingDay: next ? new Date(next.getTime() - 5 * 3_600_000).getUTCDate() : null,
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      },
      paymentMethod: sub?.paymentLast4
        ? { brand: sub.paymentBrand, last4: sub.paymentLast4, expMonth: sub.paymentExpMonth, expYear: sub.paymentExpYear }
        : null,
      billingInfo: {
        name: sub?.billingName ?? user.name,
        docType: sub?.billingDocType ?? null,
        docNumber: sub?.billingDocNumber ?? null,
        email: sub?.billingEmail ?? user.email,
        address: sub?.billingAddress ?? null,
      },
      paymentsEnabled: false,
    });
  })
);

const billingSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    docType: z.enum(["DNI", "RUC", "CE"]),
    docNumber: z.string().trim().min(6).max(15),
    email: z.string().trim().email().max(120),
    address: z.string().trim().max(160).optional().or(z.literal("")),
  })
  .superRefine((v, ctx) => {
    if (v.docType === "DNI" && !/^\d{8}$/.test(v.docNumber)) ctx.addIssue({ code: "custom", path: ["docNumber"], message: "El DNI debe tener 8 dígitos" });
    if (v.docType === "RUC" && !/^\d{11}$/.test(v.docNumber)) ctx.addIssue({ code: "custom", path: ["docNumber"], message: "El RUC debe tener 11 dígitos" });
    if (v.docType === "CE" && !/^[A-Za-z0-9]{6,12}$/.test(v.docNumber)) ctx.addIssue({ code: "custom", path: ["docNumber"], message: "Carné de extranjería inválido" });
  });

subscriptionRouter.patch(
  "/billing-info",
  asyncHandler(async (req, res) => {
    const parsed = billingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos de facturación inválidos", 422);
    const d = parsed.data;
    const data = {
      billingName: d.name,
      billingDocType: d.docType,
      billingDocNumber: d.docNumber,
      billingEmail: d.email,
      billingAddress: d.address || null,
    };
    await prisma.subscription.upsert({
      where: { userId: req.userId! },
      update: data,
      // Sin suscripción aún: se crea el registro solo con los datos de facturación (sin periodo de prueba).
      create: { userId: req.userId!, status: "ACTIVE", ...data },
    });
    res.json({ ok: true });
  })
);
