import { PLAN_FEATURES, type PlanFeatures } from "../config/plans";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { getEffectivePlan, limaMonthStart } from "./plans";

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

/**
 * Frena la creación de movimientos cuando el usuario llega a su tope por hora o por mes (Lima).
 * Cuenta también los borrados: si no, se podría crear y borrar en bucle sin límite. Solo frena los nuevos.
 */
export async function assertTxnCreationAllowed(userId: string): Promise<void> {
  const f = await getUserFeatures(userId);
  const [hour, month] = await Promise.all([
    prisma.transaction.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } }),
    prisma.transaction.count({ where: { userId, createdAt: { gte: limaMonthStart() } } }),
  ]);
  if (hour >= f.maxTxnPerHour) throw new AppError("Estás anotando movimientos muy rápido. Espera unos minutos e inténtalo de nuevo.", 429, "TXN_RATE_LIMIT");
  if (month >= f.maxTxnPerMonth) {
    throw new AppError(`Llegaste al máximo de ${f.maxTxnPerMonth} movimientos nuevos este mes de tu plan. Se renueva el día 1.`, 403, "PLAN_LIMIT");
  }
}
