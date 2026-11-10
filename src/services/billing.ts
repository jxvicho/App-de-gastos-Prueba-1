import type { BillingPeriod, Plan, Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  BILLING_PERIOD_LABELS,
  BILLING_PERIOD_MONTHS,
  DUNNING,
  PLAN_LABELS,
  PLAN_PRICE_BY_PERIOD_PEN,
  TRIAL_DAYS_BY_PERIOD,
  type SellablePlan,
} from "../config/plans";
import * as culqi from "./culqi";
import { sendBillingNotice } from "./billingNotify";
import { redisConnection } from "../queues/redisConnection";

const DAY_MS = 86_400_000;

export function paymentsAvailable(): boolean {
  return env.PAYMENTS_ENABLED && culqi.isCulqiConfigured();
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

export function priceCents(plan: SellablePlan, period: BillingPeriod): number {
  return Math.round(PLAN_PRICE_BY_PERIOD_PEN[plan][period] * 100);
}

/* ---------------------------------------------------------------
   Acceso limitado (cobro fallido) 
   --------------------------------------------------------------- */

/**
 * true si el usuario está en modo solo lectura: SOLO en los días de gracia de un cobro fallido (desde el 3.er fallo
 * hasta que se agotan los reintentos). Una suscripción cancelada nunca queda en solo lectura: conserva el acceso
 * completo hasta que termina el periodo pagado y entonces pasa al plan Gratis (ver downgradeExpiredSubscriptions).
 * Solo aplica a quien tiene una suscripción de pasarela (culqiSubscriptionId): los usuarios sin pasarela
 * (equipo, testers, plan asignado a mano) nunca se limitan.
 */
export async function isAccessRestricted(userId: string): Promise<boolean> {
  if (!env.PAYMENTS_ENABLED) return false;
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { culqiSubscriptionId: true, restrictedAt: true, status: true, currentPeriodEnd: true, trialEndsAt: true },
  });
  if (!sub?.culqiSubscriptionId) return false;
  if (sub.status === "CANCELED") return false;
  return !!sub.restrictedAt;
}

/** Devuelve al usuario al plan Gratis y levanta el solo lectura. No borra ningún dato suyo. */
export async function downgradeToFree(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { plan: "FREE" } }),
    prisma.subscription.updateMany({ where: { userId }, data: { restrictedAt: null } }),
  ]);
}

/**
 * Pasa a Gratis a quien canceló y ya terminó su periodo pagado (o su prueba). Los que se agotaron por cobros
 * fallidos ya pasaron a Gratis en el momento. Corre cada hora; solo toca suscripciones de pasarela con plan de pago.
 */
export async function downgradeExpiredSubscriptions(now: Date = new Date()): Promise<number> {
  const subs = await prisma.subscription.findMany({
    where: { status: "CANCELED", culqiSubscriptionId: { not: null }, user: { plan: { in: ["BASIC", "PRO"] } } },
    include: { user: true },
  });
  let n = 0;
  for (const sub of subs) {
    const until = sub.currentPeriodEnd ?? sub.trialEndsAt;
    if (until && until.getTime() > now.getTime()) continue; // todavía tiene acceso pagado
    await downgradeToFree(sub.userId);
    n++;
    if (sub.cancelAtPeriodEnd) await sendBillingNotice(sub.user, "DOWNGRADED");
  }
  return n;
}

/* ---------------------------------------------------------------
   Planes en Culqi (12 = 2 planes × 3 periodos × con/sin prueba)
   --------------------------------------------------------------- */

export async function ensureBillingPlan(plan: SellablePlan, period: BillingPeriod, withTrial: boolean) {
  const key = { plan_period_withTrial: { plan: plan as Plan, period, withTrial } };
  const existing = await prisma.billingPlan.findUnique({ where: key });
  if (existing) return existing;

  const amountCents = priceCents(plan, period);
  const created = await culqi.createPlan({
    name: `Gastia ${PLAN_LABELS[plan]} ${BILLING_PERIOD_LABELS[period]}${withTrial ? ` (${TRIAL_DAYS_BY_PERIOD[period]} días de prueba)` : ""}`,
    shortName: `gastia-${plan.toLowerCase()}-${period.toLowerCase()}-${withTrial ? `t${TRIAL_DAYS_BY_PERIOD[period]}` : "nt"}`,
    description: `Suscripción ${PLAN_LABELS[plan]} ${BILLING_PERIOD_LABELS[period].toLowerCase()} de Gastia`,
    amountCents,
    months: BILLING_PERIOD_MONTHS[period],
    trialDays: withTrial ? TRIAL_DAYS_BY_PERIOD[period] : 0,
  });
  try {
    return await prisma.billingPlan.create({ data: { plan: plan as Plan, period, withTrial, culqiPlanId: created.id, amountCents } });
  } catch {
    // Otra petición lo creó a la vez: se usa el que quedó guardado.
    const again = await prisma.billingPlan.findUnique({ where: key });
    if (again) return again;
    throw new AppError("No se pudo preparar el plan de pago", 500);
  }
}

/* ---------------------------------------------------------------
   Suscribirse (tarjeta + prueba de 7 días)
   --------------------------------------------------------------- */

const inFlight = new Set<string>();

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "Cliente";
  const last = parts.slice(1).join(" ") || first;
  return { first, last };
}

export async function startSubscription(input: { userId: string; plan: SellablePlan; period: BillingPeriod; tokenId: string; tyc: boolean }) {
  if (!paymentsAvailable()) throw new AppError("Los pagos aún no están disponibles", 503);
  if (!input.tyc) throw new AppError("Debes aceptar los términos y condiciones para suscribirte", 422);
  if (inFlight.has(input.userId)) throw new AppError("Ya estamos procesando tu suscripción", 409);
  inFlight.add(input.userId);
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId }, include: { subscription: true } });
    const existing = user.subscription;
    if (existing?.culqiSubscriptionId && existing.status !== "CANCELED") {
      throw new AppError("Ya tienes una suscripción activa. Cancélala primero si quieres cambiar de plan.", 409);
    }

    // La prueba gratis se da una sola vez por usuario.
    const withTrial = !existing?.trialStartedAt;
    const billingPlan = await ensureBillingPlan(input.plan, input.period, withTrial);

    const email = existing?.billingEmail || user.email;
    let customerId = existing?.culqiCustomerId ?? null;
    if (!customerId) {
      const { first, last } = splitName(existing?.billingName || user.name);
      const customer = await culqi.createCustomer({
        email,
        firstName: first,
        lastName: last,
        phone: (user.phoneNumber ?? "").replace(/\D/g, "") || "000000000",
        address: existing?.billingAddress || "Lima, Perú",
        city: "Lima",
      });
      customerId = customer.id;
    }

    const card = await culqi.createCard(customerId, input.tokenId);
    const sub = await culqi.createSubscription(card.id, billingPlan.culqiPlanId, { user_id: user.id, plan: input.plan, period: input.period });

    const now = new Date();
    const trialEndsAt = withTrial ? new Date(now.getTime() + TRIAL_DAYS_BY_PERIOD[input.period] * DAY_MS) : null;
    const periodEnd = withTrial ? null : addMonths(now, BILLING_PERIOD_MONTHS[input.period]);
    const brand = card.source?.iin?.card_brand?.toLowerCase() ?? null;
    const last4 = card.source?.last_four ?? card.source?.card_number?.slice(-4) ?? null;

    const data = {
      status: withTrial ? ("TRIALING" as const) : ("ACTIVE" as const),
      billingPeriod: input.period,
      culqiCustomerId: customerId,
      culqiCardId: card.id,
      culqiSubscriptionId: sub.id,
      failedAttempts: 0,
      restrictedAt: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      trialStartedAt: withTrial ? now : existing?.trialStartedAt ?? null,
      trialEndsAt: withTrial ? trialEndsAt : existing?.trialEndsAt ?? null,
      currentPeriodStart: withTrial ? null : now,
      currentPeriodEnd: periodEnd,
      paymentBrand: brand,
      paymentLast4: last4,
      paymentExpMonth: card.source?.expiration_month ?? null,
      paymentExpYear: card.source?.expiration_year ?? null,
    };
    await prisma.$transaction([
      prisma.subscription.upsert({
        where: { userId: user.id },
        update: data,
        create: { userId: user.id, ...data },
      }),
      prisma.user.update({ where: { id: user.id }, data: { plan: input.plan as Plan } }),
    ]);

    return { status: data.status, trialEndsAt, nextBillingDate: trialEndsAt ?? periodEnd, withTrial };
  } finally {
    inFlight.delete(input.userId);
  }
}

/* ---------------------------------------------------------------
   Cancelar
   --------------------------------------------------------------- */

/** Cancela el cobro automático. El usuario conserva el acceso hasta el fin del periodo ya pagado (o de la prueba). */
export async function cancelUserSubscription(userId: string) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub?.culqiSubscriptionId || sub.status === "CANCELED") throw new AppError("No tienes una suscripción activa", 404);

  await culqi.cancelSubscription(sub.culqiSubscriptionId);
  const accessUntil = sub.currentPeriodEnd ?? sub.trialEndsAt ?? new Date();
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELED", cancelAtPeriodEnd: true, canceledAt: new Date(), currentPeriodEnd: accessUntil },
  });
  return { accessUntil };
}

/* ---------------------------------------------------------------
   Webhook de Culqi
   --------------------------------------------------------------- */

type SubWithUser = Prisma.SubscriptionGetPayload<{ include: { user: true } }>;

async function findSubscriptionForCharge(charge: culqi.CulqiCharge): Promise<SubWithUser | null> {
  const cardId = charge.source?.id;
  if (cardId?.startsWith("crd_")) {
    const byCard = await prisma.subscription.findFirst({ where: { culqiCardId: cardId, culqiSubscriptionId: { not: null } }, include: { user: true } });
    if (byCard) return byCard;
  }
  if (charge.email) {
    return prisma.subscription.findFirst({
      where: {
        culqiSubscriptionId: { not: null },
        OR: [
          { billingEmail: { equals: charge.email, mode: "insensitive" } },
          { user: { email: { equals: charge.email, mode: "insensitive" } } },
        ],
      },
      include: { user: true },
    });
  }
  return null;
}

async function onChargeSucceeded(sub: SubWithUser, charge: culqi.CulqiCharge) {
  const now = new Date();
  const months = BILLING_PERIOD_MONTHS[sub.billingPeriod ?? "MONTHLY"];
  const wasRestricted = !!sub.restrictedAt || sub.failedAttempts > 0;
  await prisma.billingCharge.upsert({
    where: { culqiChargeId: charge.id },
    update: { status: "PAID", failureMessage: null },
    create: {
      userId: sub.userId,
      culqiChargeId: charge.id,
      culqiSubscriptionId: sub.culqiSubscriptionId,
      status: "PAID",
      amountCents: charge.amount ?? 0,
      period: sub.billingPeriod,
    },
  });
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: "ACTIVE",
      failedAttempts: 0,
      restrictedAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, months),
    },
  });
  if (wasRestricted) await sendBillingNotice(sub.user, "RECOVERED");
}

async function onChargeFailed(sub: SubWithUser, charge: culqi.CulqiCharge) {
  const message = charge.outcome?.user_message ?? charge.outcome?.merchant_message ?? null;
  await prisma.billingCharge.upsert({
    where: { culqiChargeId: charge.id },
    update: { status: "FAILED", failureMessage: message },
    create: {
      userId: sub.userId,
      culqiChargeId: charge.id,
      culqiSubscriptionId: sub.culqiSubscriptionId,
      status: "FAILED",
      amountCents: charge.amount ?? 0,
      period: sub.billingPeriod,
      failureMessage: message,
    },
  });

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: { failedAttempts: { increment: 1 }, status: "PAST_DUE" },
  });
  const attempts = updated.failedAttempts;

  if (attempts >= DUNNING.RESTRICT_AT_ATTEMPT && !updated.restrictedAt) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { restrictedAt: new Date() } });
  }
  if (attempts >= DUNNING.MAX_ATTEMPTS) {
    try {
      await culqi.cancelSubscription(updated.culqiSubscriptionId!);
    } catch (err) {
      console.error("No se pudo cancelar en Culqi tras agotar reintentos (puede que ya esté cancelada):", err);
    }
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    await downgradeToFree(sub.userId);
    await sendBillingNotice(sub.user, "CANCELED_AUTO");
  } else if (attempts === DUNNING.RESTRICT_AT_ATTEMPT) {
    await sendBillingNotice(sub.user, "RESTRICTED");
  } else if (attempts === 1) {
    await sendBillingNotice(sub.user, "FAILED_1");
  } else if (attempts === 2) {
    await sendBillingNotice(sub.user, "FAILED_2");
  }
}

export interface CulqiEventPayload {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}

/**
 * Procesa un evento de Culqi. Culqi no firma los eventos, así que NUNCA se confía en el contenido del webhook:
 * se vuelve a consultar el cargo/suscripción a la API con la llave secreta. Es idempotente por id de evento.
 */
export async function processCulqiEvent(evt: CulqiEventPayload): Promise<{ handled: boolean; reason?: string }> {
  if (typeof evt.id !== "string" || typeof evt.type !== "string") throw new AppError("Evento inválido", 400);
  const type = evt.type;
  let data = evt.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      /* se deja como string */
    }
  }
  const resourceId = (data as { id?: unknown } | undefined)?.id;

  try {
    await prisma.billingEvent.create({ data: { id: evt.id, type } });
  } catch {
    return { handled: false, reason: "duplicado" };
  }

  try {
    if (type.startsWith("charge.") && typeof resourceId === "string") {
      const charge = await culqi.getCharge(resourceId);
      const sub = await findSubscriptionForCharge(charge);
      if (!sub) return { handled: false, reason: "cargo sin suscripción de Gastia" };
      if (type === "charge.creation.succeeded") await onChargeSucceeded(sub, charge);
      else if (type === "charge.failed") await onChargeFailed(sub, charge);
      else return { handled: false, reason: "tipo de cargo no usado" };
      return { handled: true };
    }

    if (type.startsWith("subscription.") && typeof resourceId === "string" && /cancel|delet/i.test(type)) {
      const sub = await prisma.subscription.findUnique({ where: { culqiSubscriptionId: resourceId } });
      if (sub && sub.status !== "CANCELED") {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { status: "CANCELED", canceledAt: new Date(), currentPeriodEnd: sub.currentPeriodEnd ?? sub.trialEndsAt ?? new Date() },
        });
      }
      return { handled: true };
    }

    return { handled: false, reason: "evento no usado" };
  } catch (err) {
    // Que Culqi pueda reintentar el evento: se libera la marca de idempotencia.
    await prisma.billingEvent.delete({ where: { id: evt.id } }).catch(() => undefined);
    throw err;
  }
}

/* ---------------------------------------------------------------
   Actualizar tarjeta cuando hay un cobro pendiente
   --------------------------------------------------------------- */

/**
 * Para quien tiene el cobro fallando (PAST_DUE / acceso limitado): guarda la tarjeta nueva, cancela la suscripción
 * que fallaba y crea otra, sin prueba, que cobra al instante. Si el cobro pasa, el acceso se restablece en el acto.
 * (Cambiar la tarjeta de quien paga al día todavía no está disponible.)
 */
export async function updateCardAndRetry(userId: string, tokenId: string) {
  if (!paymentsAvailable()) throw new AppError("Los pagos aún no están disponibles", 503);
  if (inFlight.has(userId)) throw new AppError("Ya estamos procesando tu pago", 409);
  inFlight.add(userId);
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { subscription: true } });
    const sub = user.subscription;
    if (!sub?.culqiSubscriptionId || !sub.culqiCustomerId || !sub.billingPeriod || sub.status !== "PAST_DUE") {
      throw new AppError("Por ahora solo puedes cambiar la tarjeta cuando hay un cobro pendiente", 409);
    }
    const plan = user.plan === "PRO" ? "PRO" : user.plan === "BASIC" ? "BASIC" : null;
    if (!plan) throw new AppError("Tu plan no se cobra por tarjeta", 409);

    const billingPlan = await ensureBillingPlan(plan, sub.billingPeriod, false);
    const card = await culqi.createCard(sub.culqiCustomerId, tokenId);
    try {
      await culqi.cancelSubscription(sub.culqiSubscriptionId);
    } catch (err) {
      console.error("No se pudo cancelar la suscripción anterior en Culqi (se continúa):", err);
    }
    const created = await culqi.createSubscription(card.id, billingPlan.culqiPlanId, { user_id: user.id, plan, period: sub.billingPeriod });

    const now = new Date();
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE",
        culqiCardId: card.id,
        culqiSubscriptionId: created.id,
        failedAttempts: 0,
        restrictedAt: null,
        canceledAt: null,
        cancelAtPeriodEnd: false,
        currentPeriodStart: now,
        currentPeriodEnd: addMonths(now, BILLING_PERIOD_MONTHS[sub.billingPeriod]),
        paymentBrand: card.source?.iin?.card_brand?.toLowerCase() ?? null,
        paymentLast4: card.source?.last_four ?? card.source?.card_number?.slice(-4) ?? null,
        paymentExpMonth: card.source?.expiration_month ?? null,
        paymentExpYear: card.source?.expiration_year ?? null,
      },
    });
    await sendBillingNotice(user, "RECOVERED");
    return { status: "ACTIVE" as const };
  } finally {
    inFlight.delete(userId);
  }
}

/* ---------------------------------------------------------------
   Aviso previo al primer cobro del plan anual (no tiene reembolso)
   --------------------------------------------------------------- */

/**
 * Corre cada hora: a quien está en prueba del plan ANUAL y le faltan 2 días o menos para el primer cobro, se le avisa por
 * correo el monto y la fecha. Una sola vez por suscripción (marca en Redis).
 */
export async function sendPreChargeNotices(): Promise<number> {
  if (!paymentsAvailable()) return 0;
  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: {
      status: "TRIALING",
      billingPeriod: "ANNUAL",
      culqiSubscriptionId: { not: null },
      trialEndsAt: { gt: now, lte: new Date(now.getTime() + 2 * DAY_MS) },
    },
    include: { user: true },
  });
  let sent = 0;
  for (const sub of subs) {
    const first = await redisConnection.set(`billing:precharge:${sub.id}`, "1", "EX", 7 * DAY_MS / 1000, "NX");
    if (!first) continue;
    const plan: SellablePlan = sub.user.plan === "PRO" ? "PRO" : "BASIC";
    await sendBillingNotice(sub.user, "PRECHARGE_ANNUAL", {
      amount: `S/ ${(priceCents(plan, "ANNUAL") / 100).toFixed(2)}`,
      date: sub.trialEndsAt!.toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "numeric", month: "long" }),
    });
    sent++;
  }
  return sent;
}
