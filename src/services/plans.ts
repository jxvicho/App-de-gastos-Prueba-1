import type { Plan } from "@prisma/client";
import { prisma } from "../config/prisma";
import { PLAN_LIMITS } from "../config/plans";

export interface PlanSubject {
  plan: Plan;
  planOverride?: Plan | null;
  planOverrideUntil?: Date | null;
}

export interface EffectivePlan {
  plan: Plan;
  /** Respuestas del bot al mes; null = sin tope (UNLIMITED o promo sin tope). */
  monthlyReplies: number | null;
  source: "override" | "promo" | "plan";
  promoId?: string;
}

/**
 * Plan efectivo de un usuario en `now`. Orden:
 *  1. planOverride, si planOverrideUntil > now (o no tiene fecha de fin);
 *  2. una Promo activa vigente que aplique a su plan y que no haya gastado su presupuesto;
 *  3. su plan base.
 * TODA decisión de funciones y límites debe usar esta función.
 */
export async function getEffectivePlan(user: PlanSubject, now: Date = new Date()): Promise<EffectivePlan> {
  if (user.planOverride && (!user.planOverrideUntil || user.planOverrideUntil > now)) {
    return { plan: user.planOverride, monthlyReplies: PLAN_LIMITS[user.planOverride].monthlyReplies, source: "override" };
  }

  const promos = await prisma.promo.findMany({
    where: { active: true, startsAt: { lte: now }, endsAt: { gte: now }, appliesTo: { has: user.plan } },
    orderBy: { createdAt: "desc" },
  });
  const promo = promos.find((p) => p.spentUsd.lt(p.budgetUsd));
  if (promo) {
    return {
      plan: promo.grantsPlan,
      monthlyReplies: promo.uncapped ? null : PLAN_LIMITS[promo.grantsPlan].monthlyReplies,
      source: "promo",
      promoId: promo.id,
    };
  }

  return { plan: user.plan, monthlyReplies: PLAN_LIMITS[user.plan].monthlyReplies, source: "plan" };
}

/** Lunes-a-domingo no importa aquí: inicio del mes y del día en hora de Lima (UTC-5 fijo). */
const LIMA_OFFSET_MS = 5 * 3_600_000;

export function limaMonthStart(now: Date = new Date()): Date {
  const l = new Date(now.getTime() - LIMA_OFFSET_MS);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1, 5, 0, 0));
}

export function limaDayStart(now: Date = new Date()): Date {
  const l = new Date(now.getTime() - LIMA_OFFSET_MS);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 5, 0, 0));
}
