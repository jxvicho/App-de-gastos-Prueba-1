import { PLAN_FEATURES, type PlanFeatures } from "../config/plans";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { getEffectivePlan } from "./plans";

/** Funciones del plan efectivo del usuario (override y promos incluidos). */
export async function getUserFeatures(userId: string): Promise<PlanFeatures> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true, planOverride: true, planOverrideUntil: true } });
  if (!u) return PLAN_FEATURES.FREE;
  return PLAN_FEATURES[(await getEffectivePlan(u)).plan];
}

/** Tope de pagos fijos, metas o deudas del usuario (null = sin límite). */
export async function getUserLimits(userId: string) {
  const f = await getUserFeatures(userId);
  return { recurring: f.maxRecurring, goals: f.maxGoals, debtsPerDirection: f.maxDebtsPerDirection };
}

/**
 * Impide crear uno más cuando el usuario ya llegó al tope de su plan.
 * Nunca borra ni bloquea lo que ya existe (por ejemplo, tras bajar de Pro a Gratis): solo frena los nuevos.
 */
export function assertUnderLimit(limit: number | null, current: number, message: string): void {
  if (limit !== null && current >= limit) throw new AppError(message, 403, "PLAN_LIMIT");
}
