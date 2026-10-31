import type { Subscription, User } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { DUNNING, PLAN_PRICE_BY_PERIOD_PEN } from "../config/plans";
import { sendBillingNotice } from "./billingNotify";

/**
 * Herramientas de PRUEBA del panel de administración: simulan cobros fallidos y recuperados sin llamar a Culqi,
 * para ver el modo solo lectura y los avisos. Solo con llaves de prueba (nunca con sk_live_).
 * Usan una suscripción simulada (culqiSubscriptionId "sim_...") para que isAccessRestricted las trate como reales.
 */
export function billingToolsAllowed(): boolean {
  return !env.CULQI_SECRET_KEY.startsWith("sk_live_");
}

export type SimAction = "fail" | "recover" | "precharge-notice" | "clear";

type SubWithUser = Subscription & { user: User };

function isSim(sub: Subscription | null): boolean {
  return !!sub?.culqiSubscriptionId?.startsWith("sim_");
}

async function loadForSim(userId: string): Promise<SubWithUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { subscription: true } });
  if (!user) throw new AppError("Usuario no encontrado", 404);
  const existing = user.subscription;
  if (existing?.culqiSubscriptionId && !isSim(existing)) {
    throw new AppError(
      "Este usuario tiene una suscripción real en Culqi. Para probar cobros usa los eventos del sandbox de Culqi o un usuario de prueba.",
      409
    );
  }
  const sub =
    existing ??
    (await prisma.subscription.create({
      data: {
        userId,
        status: "ACTIVE",
        billingPeriod: "MONTHLY",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    }));
  const withSim = sub.culqiSubscriptionId
    ? sub
    : await prisma.subscription.update({ where: { id: sub.id }, data: { culqiSubscriptionId: `sim_${userId}` } });
  const { subscription: _omit, ...userOnly } = user;
  return { ...withSim, user: userOnly as User };
}

function simAmountCents(user: User, sub: Subscription): number {
  const plan = user.plan === "PRO" ? "PRO" : "BASIC";
  return Math.round(PLAN_PRICE_BY_PERIOD_PEN[plan][sub.billingPeriod ?? "MONTHLY"] * 100);
}

export async function simulateBilling(userId: string, action: SimAction): Promise<{ message: string }> {
  if (!billingToolsAllowed()) throw new AppError("Las pruebas de cobro están desactivadas con llaves de producción", 403);

  if (action === "clear") {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    if (!sub) return { message: "El usuario no tiene suscripción." };
    if (!isSim(sub)) throw new AppError("La suscripción de este usuario no es simulada; no se toca.", 409);
    await prisma.billingCharge.deleteMany({ where: { userId, culqiChargeId: { startsWith: "sim_chr_" } } });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { culqiSubscriptionId: null, failedAttempts: 0, restrictedAt: null, canceledAt: null, status: "ACTIVE" },
    });
    return { message: "Simulación borrada: el usuario vuelve a no tener pasarela y nunca queda limitado." };
  }

  const sub = await loadForSim(userId);

  if (action === "fail") {
    const attempts = sub.failedAttempts + 1;
    await prisma.billingCharge.create({
      data: {
        userId,
        culqiChargeId: `sim_chr_${Date.now()}_${attempts}`,
        culqiSubscriptionId: sub.culqiSubscriptionId,
        status: "FAILED",
        amountCents: simAmountCents(sub.user, sub),
        period: sub.billingPeriod,
        failureMessage: "Simulado desde el panel de administración",
      },
    });
    const data: Partial<Subscription> = { failedAttempts: attempts, status: "PAST_DUE" };
    if (attempts >= DUNNING.RESTRICT_AT_ATTEMPT && !sub.restrictedAt) data.restrictedAt = new Date();
    if (attempts >= DUNNING.MAX_ATTEMPTS) {
      data.status = "CANCELED";
      data.canceledAt = new Date();
    }
    await prisma.subscription.update({ where: { id: sub.id }, data });
    if (attempts >= DUNNING.MAX_ATTEMPTS) await sendBillingNotice(sub.user, "CANCELED_AUTO");
    else if (attempts === DUNNING.RESTRICT_AT_ATTEMPT) await sendBillingNotice(sub.user, "RESTRICTED");
    else if (attempts === 1) await sendBillingNotice(sub.user, "FAILED_1");
    else if (attempts === 2) await sendBillingNotice(sub.user, "FAILED_2");
    const extra = env.PAYMENTS_ENABLED ? "" : " Ojo: PAYMENTS_ENABLED está en false, así que el modo solo lectura no se aplica.";
    return { message: `Cobro fallido simulado: intento ${attempts} de ${DUNNING.MAX_ATTEMPTS}.${extra}` };
  }

  if (action === "recover") {
    const wasBad = !!sub.restrictedAt || sub.failedAttempts > 0;
    await prisma.billingCharge.create({
      data: {
        userId,
        culqiChargeId: `sim_chr_${Date.now()}_ok`,
        culqiSubscriptionId: sub.culqiSubscriptionId,
        status: "PAID",
        amountCents: simAmountCents(sub.user, sub),
        period: sub.billingPeriod,
      },
    });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "ACTIVE", failedAttempts: 0, restrictedAt: null, canceledAt: null },
    });
    if (wasBad) await sendBillingNotice(sub.user, "RECOVERED");
    return { message: "Pago recuperado simulado: acceso completo de nuevo." };
  }

  // precharge-notice
  const amount = (simAmountCents(sub.user, { ...sub, billingPeriod: "ANNUAL" } as Subscription) / 100).toFixed(2);
  const date = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("es-PE", { timeZone: "America/Lima" });
  await sendBillingNotice(sub.user, "PRECHARGE_ANNUAL", { amount: `S/ ${amount}`, date });
  return { message: `Aviso previo del plan anual enviado (S/ ${amount}, cobro el ${date}).` };
}
