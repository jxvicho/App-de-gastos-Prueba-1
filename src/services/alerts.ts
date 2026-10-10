import type { Transaction, User } from "@prisma/client";
import { prisma } from "../config/prisma";
import { redisConnection } from "../queues/redisConnection";
import { isWindowOpen, sendTextMessage } from "./whatsapp";
import { limaMonthStart } from "./plans";
import { formatMoneyPlain } from "./weeklyReportData";

const ALERT_KEY_TTL_SECONDS = 40 * 24 * 3600;
const PENDING_ALERTS_TTL_SECONDS = 3 * 24 * 3600;

/**
 * Entrega una alerta: con la ventana de 24 h abierta va como mensaje de
 * servicio (kind "alert"); si está cerrada se guarda para incluirla en el
 * resumen diario (nunca se envía fuera de ventana ni se pierde).
 */
async function deliverAlert(user: User, text: string): Promise<void> {
  if (!user.phoneNumber) return;
  if (await isWindowOpen(user.phoneNumber)) {
    await sendTextMessage(user.phoneNumber, text, { kind: "alert" });
    return;
  }
  const key = `alerts:pending:${user.id}`;
  await redisConnection.rpush(key, text);
  await redisConnection.expire(key, PENDING_ALERTS_TTL_SECONDS);
}

/** Alertas acumuladas (ventana cerrada) para el resumen diario; se vacían al leerlas. */
export async function takePendingAlerts(userId: string): Promise<string[]> {
  const key = `alerts:pending:${userId}`;
  const items = await redisConnection.lrange(key, 0, -1);
  if (items.length) await redisConnection.del(key);
  return items;
}

/** true solo la primera vez que se pide esta clave (una alerta por categoría, mes y umbral). */
async function firstTime(key: string): Promise<boolean> {
  return (await redisConnection.set(key, "1", "EX", ALERT_KEY_TTL_SECONDS, "NX")) === "OK";
}

function nextMonthStart(monthStart: Date): Date {
  const l = new Date(monthStart.getTime() - 5 * 3_600_000);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 1, 1, 5, 0, 0));
}

async function spentThisMonth(userId: string, currency: string, monthStart: Date, categoryId?: string): Promise<number> {
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      currency,
      type: "EXPENSE",
      status: { in: ["CONFIRMED", "AUTO_CONFIRMED"] },
      deletedAt: null,
      categoryId,
      category: { excludeFromTotals: false },
      occurredAt: { gte: monthStart, lt: nextMonthStart(monthStart) },
    },
    select: { amount: true },
  });
  return rows.reduce((acc, r) => acc + Number(r.amount), 0);
}

/**
 * Alertas de PRO/UNLIMITED al registrar un consumo del correo:
 *  1. gasto >= umbral del usuario (en soles);
 *  2. presupuesto total y por categoría al 80 % y al 100 %, UNA sola vez por mes.
 */
export async function processAlertsForTransaction(
  user: User,
  tx: Transaction,
  category: { id: string; name: string } | null
): Promise<void> {
  try {
    if (tx.type !== "EXPENSE" || tx.status === "REJECTED") return;
    const amount = Number(tx.amount);

    // 1) Umbral de gasto individual (el umbral se define en soles).
    if (user.alertThreshold && tx.currency === "PEN" && amount >= Number(user.alertThreshold)) {
      await deliverAlert(
        user,
        `🔔 Gasto alto: ${formatMoneyPlain(amount, tx.currency)} en ${tx.merchant || tx.description || "un comercio"}` +
          `${category ? ` (${category.name})` : ""}. Tu umbral de alerta es ${formatMoneyPlain(Number(user.alertThreshold), "PEN")}.`
      );
    }

    // 2) Presupuesto del mes (total y por categoría).
    const monthStart = limaMonthStart(tx.occurredAt);
    const budget = await prisma.budget.findFirst({
      where: { userId: user.id, scope: "PERSONAL", currency: tx.currency, periodStart: { lte: tx.occurredAt }, periodEnd: { gte: tx.occurredAt } },
    });
    const monthKey = `${monthStart.getUTCFullYear()}-${monthStart.getUTCMonth() + 1}`;

    const checks: { label: string; limit: number; categoryId?: string; keyId: string }[] = [];
    if (budget) checks.push({ label: "tu presupuesto del mes", limit: Number(budget.totalAmount), keyId: "total" });
    // Meta mensual de la categoría (sección "Metas por categoría" del Sandbox).
    const goal = category
      ? await prisma.categoryGoal.findUnique({ where: { userId_categoryId_currency: { userId: user.id, categoryId: category.id, currency: tx.currency } } })
      : null;
    if (category && goal) {
      checks.push({ label: `tu meta de ${category.name}`, limit: Number(goal.amount), categoryId: category.id, keyId: category.id });
    }

    for (const c of checks) {
      if (c.limit <= 0) continue;
      const spent = await spentThisMonth(user.id, tx.currency, monthStart, c.categoryId);
      const pct = (spent / c.limit) * 100;
      const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
      if (!level) continue;
      // Si se cruzan 80 y 100 de golpe, solo se avisa el nivel más alto (y el más bajo se marca como ya avisado).
      if (level === 100) await firstTime(`alert:budget:${user.id}:${monthKey}:${tx.currency}:${c.keyId}:80`);
      if (!(await firstTime(`alert:budget:${user.id}:${monthKey}:${tx.currency}:${c.keyId}:${level}`))) continue;
      await deliverAlert(
        user,
        level === 100
          ? `🚨 Llegaste al 100 % de ${c.label}: llevas ${formatMoneyPlain(spent, tx.currency)} de ${formatMoneyPlain(c.limit, tx.currency)}.`
          : `⚠️ Vas al ${Math.round(pct)} % de ${c.label}: ${formatMoneyPlain(spent, tx.currency)} de ${formatMoneyPlain(c.limit, tx.currency)}.`
      );
    }
  } catch (err) {
    console.error("Error evaluando alertas:", err);
  }
}
