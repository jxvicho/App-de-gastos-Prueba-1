import { Router, type Request } from "express";
import { Prisma, type Plan } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  BILLING_PERIOD_MONTHS, PLAN_PRICE_BY_PERIOD_PEN, PLAN_LABELS, PLAN_FEATURES, PLAN_LIMITS, PLAN_PRICES_FOR_PANEL, VISIBLE_PLANS,
  TRIAL_DAYS_BY_PERIOD, BILLING_PERIOD_LABELS, DUNNING, DAILY_HARD_CAP_PER_USER, DAILY_SUMMARY_HOUR_LIMA, META_RATE_USD_PE,
  META_FREE_SERVICE_MESSAGES_PER_MONTH, COUNTED_MESSAGE_KINDS,
} from "../config/plans";
import { getEffectivePlan, limaMonthStart } from "../services/plans";
import { isAccessRestricted } from "../services/billing";
import { billingToolsAllowed, simulateBilling } from "../services/adminTools";

/**
 * Panel de administración (public/admin.html). Todo pasa por requireAuth + requireAdmin (correos de ADMIN_EMAILS).
 * Cada cambio queda en admin_audit_logs.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const DAY_MS = 86_400_000;
const planEnum = z.enum(["FREE", "BASIC", "PRO", "UNLIMITED"]);

async function audit(req: Request, action: string, targetUserId: string | null, details?: Record<string, unknown>) {
  await prisma.adminAuditLog.create({
    data: { adminEmail: req.adminEmail ?? "?", targetUserId, action, details: (details ?? {}) as Prisma.InputJsonValue },
  });
}

function publicUser<T extends { passwordHash?: unknown; resetPasswordTokenHash?: unknown }>(u: T) {
  const { passwordHash, resetPasswordTokenHash, ...rest } = u as Record<string, unknown>;
  void passwordHash;
  void resetPasswordTokenHash;
  return rest;
}

/** Planes: qué incluye cada uno, precios, pruebas y topes. Todo sale de config/plans.ts (la misma fuente que aplica los permisos). */
adminRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const counts = await prisma.user.groupBy({ by: ["plan"], _count: { _all: true } });
    const countBy = Object.fromEntries(counts.map((c) => [c.plan, c._count._all]));
    const order: Plan[] = ["FREE", "BASIC", "PRO", "UNLIMITED"];
    res.json({
      plans: order.map((p) => ({
        id: p,
        label: PLAN_LABELS[p],
        visible: VISIBLE_PLANS.includes(p),
        users: countBy[p] ?? 0,
        prices: PLAN_PRICES_FOR_PANEL[p] ?? null,
        // Solo los planes de pago tienen prueba; la duración depende del periodo elegido.
        trialDays: p === "BASIC" || p === "PRO" ? TRIAL_DAYS_BY_PERIOD : null,
        features: PLAN_FEATURES[p],
        monthlyReplies: PLAN_LIMITS[p].monthlyReplies,
      })),
      global: {
        dailyHardCapPerUser: DAILY_HARD_CAP_PER_USER,
        dailySummaryHourLima: DAILY_SUMMARY_HOUR_LIMA,
        metaRateUsd: META_RATE_USD_PE,
        metaFreeServiceMessages: META_FREE_SERVICE_MESSAGES_PER_MONTH,
        periodLabels: BILLING_PERIOD_LABELS,
        periodMonths: BILLING_PERIOD_MONTHS,
        dunning: DUNNING,
        paymentsEnabled: env.PAYMENTS_ENABLED,
        counted: COUNTED_MESSAGE_KINDS,
      },
    });
  })
);

/** Quién soy y qué herramientas hay disponibles (el panel lo usa para mostrar u ocultar secciones). */
adminRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json({
      email: req.adminEmail,
      paymentsEnabled: env.PAYMENTS_ENABLED,
      billingTools: billingToolsAllowed(),
      culqiMode: env.CULQI_SECRET_KEY.startsWith("sk_live_") ? "live" : env.CULQI_SECRET_KEY ? "sandbox" : "sin llaves",
    });
  })
);

adminRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const since7 = new Date(now.getTime() - 7 * DAY_MS);
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const monthStart = limaMonthStart(now);

    const [totalUsers, new7, new30, byPlan, subs, chargesPaid, chargesFailed, msgs, msgCost, promos, overrides] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since7 } } }),
      prisma.user.count({ where: { createdAt: { gte: since30 } } }),
      prisma.user.groupBy({ by: ["plan"], _count: { _all: true } }),
      prisma.subscription.findMany({
        select: { status: true, restrictedAt: true, culqiSubscriptionId: true, billingPeriod: true, user: { select: { plan: true } } },
      }),
      prisma.billingCharge.aggregate({
        where: { status: "PAID", createdAt: { gte: since30 }, NOT: { culqiChargeId: { startsWith: "sim_" } } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      prisma.billingCharge.count({
        where: { status: "FAILED", createdAt: { gte: since30 }, NOT: { culqiChargeId: { startsWith: "sim_" } } },
      }),
      prisma.outboundMessage.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.outboundMessage.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true } }),
      prisma.promo.count({ where: { active: true, endsAt: { gte: now } } }),
      prisma.user.count({ where: { planOverride: { not: null } } }),
    ]);

    const statusCount: Record<string, number> = { TRIALING: 0, ACTIVE: 0, PAST_DUE: 0, CANCELED: 0 };
    let restricted = 0;
    let mrr = 0;
    for (const s of subs) {
      statusCount[s.status] = (statusCount[s.status] ?? 0) + 1;
      if (s.restrictedAt) restricted++;
      // Ingreso mensual estimado: solo suscripciones con pasarela real, activas, con plan vendible.
      if (s.status === "ACTIVE" && s.culqiSubscriptionId && !s.culqiSubscriptionId.startsWith("sim_") && s.billingPeriod && (s.user.plan === "BASIC" || s.user.plan === "PRO")) {
        mrr += PLAN_PRICE_BY_PERIOD_PEN[s.user.plan][s.billingPeriod] / BILLING_PERIOD_MONTHS[s.billingPeriod];
      }
    }

    res.json({
      users: { total: totalUsers, last7d: new7, last30d: new30, byPlan: Object.fromEntries(byPlan.map((p) => [p.plan, p._count._all])), withTemporaryPlan: overrides },
      subscriptions: { ...statusCount, restricted },
      mrrPen: Math.round(mrr * 100) / 100,
      charges30d: { paidCount: chargesPaid._count._all, paidPen: (chargesPaid._sum.amountCents ?? 0) / 100, failedCount: chargesFailed },
      whatsappThisMonth: { messages: msgs, costUsd: Number(msgCost._sum.costUsd ?? 0) },
      activePromos: promos,
    });
  })
);

/* ---------------- Usuarios ---------------- */

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  plan: planEnum.optional(),
  status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "NONE"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const where: Prisma.UserWhereInput = {};
    if (q.q) {
      where.OR = [
        { email: { contains: q.q, mode: "insensitive" } },
        { name: { contains: q.q, mode: "insensitive" } },
        { phoneNumber: { contains: q.q } },
      ];
    }
    if (q.plan) where.plan = q.plan;
    if (q.status === "NONE") where.subscription = { is: null };
    else if (q.status) where.subscription = { is: { status: q.status } };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
        skip: q.offset,
        select: {
          id: true, name: true, email: true, phoneNumber: true, plan: true, planOverride: true, planOverrideUntil: true,
          whatsappOptIn: true, createdAt: true, lastInboundAt: true,
          subscription: {
            select: { status: true, billingPeriod: true, trialEndsAt: true, currentPeriodEnd: true, failedAttempts: true, restrictedAt: true, culqiSubscriptionId: true },
          },
          _count: { select: { transactions: true } },
        },
      }),
    ]);

    res.json({
      total,
      users: users.map((u) => ({
        ...u,
        subscription: u.subscription
          ? { ...u.subscription, culqiSubscriptionId: undefined, hasGateway: !!u.subscription.culqiSubscriptionId, simulated: !!u.subscription.culqiSubscriptionId?.startsWith("sim_") }
          : null,
      })),
    });
  })
);

adminRouter.get(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        subscription: true,
        billingCharges: { orderBy: { createdAt: "desc" }, take: 10 },
        emailAccounts: { select: { id: true, provider: true, emailAddress: true } },
        _count: { select: { transactions: true, categories: true, budgets: true } },
      },
    });
    if (!user) throw new AppError("Usuario no encontrado", 404);
    const [effective, restricted, msgs] = await Promise.all([
      getEffectivePlan(user),
      isAccessRestricted(user.id),
      prisma.outboundMessage.count({ where: { userId: user.id, createdAt: { gte: limaMonthStart() } } }),
    ]);
    const { subscription, billingCharges, ...rest } = publicUser(user) as Record<string, unknown> & {
      subscription: (Record<string, unknown> & { culqiSubscriptionId?: string | null; culqiCustomerId?: string | null; culqiCardId?: string | null }) | null;
      billingCharges: unknown[];
    };
    res.json({
      user: rest,
      subscription: subscription
        ? { ...subscription, culqiCustomerId: undefined, culqiCardId: undefined, culqiSubscriptionId: undefined, hasGateway: !!subscription.culqiSubscriptionId, simulated: !!subscription.culqiSubscriptionId?.startsWith("sim_") }
        : null,
      charges: billingCharges,
      effectivePlan: effective,
      accessRestricted: restricted,
      whatsappMessagesThisMonth: msgs,
    });
  })
);

adminRouter.post(
  "/users/:id/plan",
  asyncHandler(async (req, res) => {
    const { plan } = z.object({ plan: planEnum }).parse(req.body);
    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: { plan: true } });
    if (!before) throw new AppError("Usuario no encontrado", 404);
    await prisma.user.update({ where: { id: req.params.id }, data: { plan } });
    await audit(req, "plan.set", req.params.id, { from: before.plan, to: plan });
    res.json({ ok: true });
  })
);

/** Plan temporal (equipo, testers, cortesías). plan=null lo quita. Sin days = sin fecha de fin. */
adminRouter.post(
  "/users/:id/override",
  asyncHandler(async (req, res) => {
    const body = z.object({ plan: planEnum.nullable(), days: z.number().int().min(1).max(730).optional() }).parse(req.body);
    const exists = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) throw new AppError("Usuario no encontrado", 404);
    const until = body.plan && body.days ? new Date(Date.now() + body.days * DAY_MS) : null;
    await prisma.user.update({
      where: { id: req.params.id },
      data: { planOverride: body.plan, planOverrideUntil: body.plan ? until : null },
    });
    await audit(req, body.plan ? "override.set" : "override.clear", req.params.id, { plan: body.plan, days: body.days ?? null });
    res.json({ ok: true, until });
  })
);

/** Prueba gratis extra: fija el fin de la prueba a hoy + N días. Solo para quien no tiene suscripción real en la pasarela. */
adminRouter.post(
  "/users/:id/trial",
  asyncHandler(async (req, res) => {
    const { days } = z.object({ days: z.number().int().min(1).max(90) }).parse(req.body);
    const sub = await prisma.subscription.findUnique({ where: { userId: req.params.id } });
    if (sub?.culqiSubscriptionId && !sub.culqiSubscriptionId.startsWith("sim_")) {
      throw new AppError("Este usuario tiene una suscripción real en Culqi: su prueba la maneja la pasarela.", 409);
    }
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + days * DAY_MS);
    if (sub) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "TRIALING", trialStartedAt: sub.trialStartedAt ?? now, trialEndsAt } });
    } else {
      const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!user) throw new AppError("Usuario no encontrado", 404);
      await prisma.subscription.create({ data: { userId: user.id, status: "TRIALING", trialStartedAt: now, trialEndsAt } });
    }
    await audit(req, "trial.set", req.params.id, { days, trialEndsAt });
    res.json({ ok: true, trialEndsAt });
  })
);

/** Pruebas de cobro: simulan fallos y recuperaciones sin llamar a Culqi (solo con llaves de prueba). */
adminRouter.post(
  "/users/:id/billing-test",
  asyncHandler(async (req, res) => {
    const { action } = z.object({ action: z.enum(["fail", "recover", "precharge-notice", "clear"]) }).parse(req.body);
    const result = await simulateBilling(req.params.id, action);
    await audit(req, `billing-test.${action}`, req.params.id, { message: result.message });
    res.json({ ok: true, ...result });
  })
);

/* ---------------- Promociones ---------------- */

adminRouter.get(
  "/promos",
  asyncHandler(async (_req, res) => {
    const promos = await prisma.promo.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    res.json({ promos: promos.map((p) => ({ ...p, budgetUsd: Number(p.budgetUsd), spentUsd: Number(p.spentUsd) })) });
  })
);

const promoBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    appliesTo: z.array(planEnum).min(1),
    grantsPlan: planEnum,
    uncapped: z.boolean().default(true),
    budgetUsd: z.number().min(0).max(100000),
  })
  .refine((p) => p.endsAt > p.startsAt, { message: "La fecha de fin debe ser posterior a la de inicio", path: ["endsAt"] });

adminRouter.post(
  "/promos",
  asyncHandler(async (req, res) => {
    const body = promoBody.parse(req.body);
    const promo = await prisma.promo.create({ data: { ...body, budgetUsd: new Prisma.Decimal(body.budgetUsd) } });
    await audit(req, "promo.create", null, { id: promo.id, name: promo.name, grantsPlan: promo.grantsPlan });
    res.status(201).json({ id: promo.id });
  })
);

adminRouter.patch(
  "/promos/:id",
  asyncHandler(async (req, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const promo = await prisma.promo.update({ where: { id: req.params.id }, data: { active } }).catch(() => null);
    if (!promo) throw new AppError("Promoción no encontrada", 404);
    await audit(req, active ? "promo.activate" : "promo.deactivate", null, { id: promo.id, name: promo.name });
    res.json({ ok: true });
  })
);

/* ---------------- Registro ---------------- */

adminRouter.get(
  "/audit",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    const ids = Array.from(new Set(rows.map((r) => r.targetUserId).filter((x): x is string => !!x)));
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }) : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    res.json({ entries: rows.map((r) => ({ ...r, targetEmail: r.targetUserId ? emailById.get(r.targetUserId) ?? null : null })) });
  })
);
