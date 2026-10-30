import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { env } from "../config/env";
import {
  BILLING_PERIODS,
  BILLING_PERIOD_LABELS,
  PLAN_LABELS,
  PLAN_PRICE_BY_PERIOD_PEN,
  PLAN_PRICE_PEN,
  SELLABLE_PLANS,
  TRIAL_DAYS,
  TRIAL_DAYS_BY_PERIOD,
} from "../config/plans";
import { getEffectivePlan } from "../services/plans";
import {
  cancelUserSubscription,
  isAccessRestricted,
  paymentsAvailable,
  startSubscription,
  updateCardAndRetry,
} from "../services/billing";

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth);

const DAY_MS = 86_400_000;

/**
 * Estado de la suscripción para "Plan y suscripción". `paymentsEnabled` es true solo con Culqi configurado
 * (PAYMENTS_ENABLED=true + llaves); sin eso la pantalla sigue siendo informativa.
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
    const restricted = await isAccessRestricted(req.userId!);
    const period = sub?.billingPeriod ?? null;
    const sellable = eff.plan === "BASIC" || eff.plan === "PRO" ? eff.plan : null;

    res.json({
      plan: eff.plan,
      planLabel: PLAN_LABELS[eff.plan],
      source: eff.source, // plan | promo | override
      priceMonthly: PLAN_PRICE_PEN[eff.plan],
      // Precio del periodo contratado (null si todavía no hay suscripción con tarjeta).
      price: sellable && period ? PLAN_PRICE_BY_PERIOD_PEN[sellable][period] : null,
      period,
      periodLabel: period ? BILLING_PERIOD_LABELS[period] : null,
      currency: "PEN",
      status: sub?.status ?? null,
      trial: sub?.trialEndsAt
        ? { active: trialActive, endsAt: trialEnds, daysLeft: trialDaysLeft, totalDays: trialTotalDays }
        : null,
      billing: {
        nextBillingDate: next,
        billingDay: next ? new Date(next.getTime() - 5 * 3_600_000).getUTCDate() : null,
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
        hasSubscription: !!sub?.culqiSubscriptionId,
        failedAttempts: sub?.failedAttempts ?? 0,
        pastDue: sub?.status === "PAST_DUE",
      },
      // Modo solo lectura por cobro pendiente (desde el 3.er intento fallido).
      accessRestricted: restricted,
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
      paymentsEnabled: paymentsAvailable(),
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

/** Catálogo para la pantalla de suscripción: planes, periodos y precios, y la llave PÚBLICA de Culqi (la secreta nunca sale del servidor). */
subscriptionRouter.get(
  "/plans",
  asyncHandler(async (req, res) => {
    const sub = await prisma.subscription.findUnique({ where: { userId: req.userId! }, select: { trialStartedAt: true } });
    res.json({
      paymentsEnabled: paymentsAvailable(),
      publicKey: paymentsAvailable() ? env.CULQI_PUBLIC_KEY : null,
      trialDaysByPeriod: TRIAL_DAYS_BY_PERIOD,
      trialAvailable: !sub?.trialStartedAt,
      currency: "PEN",
      periods: BILLING_PERIODS.map((p) => ({ id: p, label: BILLING_PERIOD_LABELS[p] })),
      plans: SELLABLE_PLANS.map((plan) => ({ id: plan, label: PLAN_LABELS[plan], prices: PLAN_PRICE_BY_PERIOD_PEN[plan] })),
    });
  })
);

const checkoutSchema = z.object({
  plan: z.enum(["BASIC", "PRO"]),
  period: z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]),
  // Token de la tarjeta generado por Culqi Checkout en el navegador (los datos de la tarjeta nunca pasan por nuestro servidor).
  tokenId: z.string().trim().regex(/^tkn_(test|live)_[A-Za-z0-9]+$/, "Token de tarjeta inválido"),
  tyc: z.literal(true, { errorMap: () => ({ message: "Debes aceptar los términos y condiciones" }) }),
});

subscriptionRouter.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const result = await startSubscription({ userId: req.userId!, ...parsed.data });
    res.status(201).json({ ok: true, ...result });
  })
);

subscriptionRouter.post(
  "/cancel",
  asyncHandler(async (req, res) => {
    const result = await cancelUserSubscription(req.userId!);
    res.json({ ok: true, ...result });
  })
);

const cardSchema = z.object({ tokenId: z.string().trim().regex(/^tkn_(test|live)_[A-Za-z0-9]+$/, "Token de tarjeta inválido") });

/** Con un cobro fallando: tarjeta nueva y reintento inmediato; si pasa, el acceso se restablece al instante. */
subscriptionRouter.post(
  "/update-card",
  asyncHandler(async (req, res) => {
    const parsed = cardSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Datos inválidos", 422);
    const result = await updateCardAndRetry(req.userId!, parsed.data.tokenId);
    res.json({ ok: true, ...result });
  })
);
