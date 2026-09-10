import type { TransactionStatus } from "@prisma/client";
import { prisma } from "../config/prisma";

// Perú no tiene horario de verano — offset fijo, sin necesidad de una
// librería de zonas horarias para esto.
const LIMA_OFFSET_HOURS = 5;
const DAY_MS = 86_400_000;

const MONTH_NAMES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAY_LABELS_ES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

// Definición de "confirmado" (dinero real) reusada de las mismas funciones
// de agregados que ya usa whatsappBot.ts (sumConfirmedThisMonth,
// sumConfirmedAllTimeByCurrency) — CONFIRMED + AUTO_CONFIRMED, sin eliminar.
const CONFIRMED_STATUSES: TransactionStatus[] = ["CONFIRMED", "AUTO_CONFIRMED"];

// Soles y dólares nunca se suman en un solo total, así que cada reporte
// semanal se arma para UNA sola moneda (el caller decide cuál —
// weeklyReportSender.ts revisa qué monedas tuvieron movimiento esa semana y
// arma un reporte separado por cada una). PEN es el default histórico: se
// usa para el fallback de "sin movimientos" y si el caller no especifica.
const DEFAULT_REPORT_CURRENCY = "PEN";

/** Fecha UTC que representa esa hora de pared en Lima (UTC-5 fijo). */
function limaWallClockToUtc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour + LIMA_OFFSET_HOURS, minute));
}

/** Componentes de fecha/hora en Lima (Y/M/D/día de semana) a partir de un instante UTC. */
function toLimaParts(date: Date): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(date.getTime() - LIMA_OFFSET_HOURS * 3_600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 = domingo
  };
}

/**
 * Lunes 00:00 (Lima) de la semana que contiene `reference`. `reference` por
 * defecto es ahora — para el cron de las 8pm del domingo, es el lunes de
 * esa misma semana; para el comando manual (cualquier día/hora), también.
 */
export function currentWeekStart(reference: Date = new Date()): Date {
  const { year, month, day, weekday } = toLimaParts(reference);
  const daysSinceMonday = (weekday + 6) % 7;
  return limaWallClockToUtc(year, month, day - daysSinceMonday, 0, 0);
}

/** "7 - 13 sep" a partir del lunes de la semana (asume que termina el domingo siguiente). */
export function formatWeekLabel(weekStart: Date): string {
  const startParts = toLimaParts(weekStart);
  const sundayUtc = new Date(weekStart.getTime() + 6 * DAY_MS);
  const endParts = toLimaParts(sundayUtc);
  const monthLabel = MONTH_NAMES_ES[endParts.month];
  return `${startParts.day} - ${endParts.day} ${monthLabel}`;
}

interface RawTxn {
  amount: number;
  type: "EXPENSE" | "INCOME";
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  occurredAt: Date;
}

async function fetchConfirmed(userId: string, start: Date, end: Date, currency: string): Promise<RawTxn[]> {
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      status: { in: CONFIRMED_STATUSES },
      deletedAt: null,
      currency,
      occurredAt: { gte: start, lt: end },
    },
    include: { category: true },
  });
  return rows.map((t) => ({
    amount: Number(t.amount),
    type: t.type,
    categoryId: t.categoryId,
    categoryName: t.category?.name ?? null,
    categoryIcon: t.category?.icon ?? null,
    categoryColor: t.category?.colorHex ?? null,
    occurredAt: t.occurredAt,
  }));
}

function sumExpense(rows: RawTxn[]): number {
  return rows
    .filter((t) => t.type === "EXPENSE" && t.categoryName !== "No considerar")
    .reduce((acc, t) => acc + t.amount, 0);
}

function sumIncome(rows: RawTxn[]): number {
  return rows.filter((t) => t.type === "INCOME").reduce((acc, t) => acc + t.amount, 0);
}

/** % de cambio de `current` vs `previous`; null si `previous` es 0 (no hay base válida para comparar). */
function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export interface WeeklyCategoryBreakdown {
  name: string;
  icon: string;
  colorHex: string;
  amount: number;
}

export interface WeeklyReportData {
  userName: string;
  weekStart: Date;
  weekEnd: Date;
  weekLabel: string;
  currency: string;
  totalExpense: number;
  totalIncome: number;
  expenseChangePct: number | null;
  incomeChangePct: number | null;
  categoryBreakdown: WeeklyCategoryBreakdown[]; // top 4 + "Otras" si aplica, desc
  dayTotals: { label: string; amount: number }[]; // Lunes..Domingo (7)
  peakDayIndex: number | null; // índice 0-6 del día con más gasto, null si no hubo gastos
  weeklyBudget: number | null; // null si no hay presupuesto configurado ese mes
  topCategory: { name: string; icon: string; amount: number; pct: number } | null;
  peakDay: { label: string; amount: number } | null;
  hasAnyMovement: boolean; // false -> "Sin movimientos esta semana" (no se genera imagen)
}

const OTHER_CATEGORY_ICON = "🔖";
const FALLBACK_CATEGORY_ICON = "🏷️";

/**
 * Qué monedas tuvieron al menos un movimiento confirmado (EXPENSE o INCOME,
 * sin eliminar) en [weekStart, weekEnd) para este usuario — decide cuántos
 * reportes semanales se mandan y de cuáles monedas (weeklyReportSender.ts).
 */
export async function getCurrenciesWithMovement(userId: string, weekStart: Date, weekEnd: Date): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      status: { in: CONFIRMED_STATUSES },
      deletedAt: null,
      occurredAt: { gte: weekStart, lt: weekEnd },
    },
    distinct: ["currency"],
    select: { currency: true },
  });
  return rows.map((r) => r.currency);
}

/**
 * Arma todos los datos del reporte semanal para un usuario, un rango
 * [weekStart, weekEnd) y UNA moneda — el caller decide el rango exacto (el
 * cron usa lunes 00:00 a domingo 20:00 Lima; el comando manual usa lunes
 * 00:00 a "ahora", para poder probar cualquier día) y la moneda (ver
 * getCurrenciesWithMovement arriba).
 */
export async function buildWeeklyReportData(
  userId: string,
  userName: string,
  weekStart: Date,
  weekEnd: Date,
  currency: string = DEFAULT_REPORT_CURRENCY
): Promise<WeeklyReportData> {
  const prevWeekStart = new Date(weekStart.getTime() - 7 * DAY_MS);
  const prevWeekEnd = new Date(weekEnd.getTime() - 7 * DAY_MS);

  const [thisWeek, prevWeek, budget] = await Promise.all([
    fetchConfirmed(userId, weekStart, weekEnd, currency),
    fetchConfirmed(userId, prevWeekStart, prevWeekEnd, currency),
    prisma.budget.findFirst({
      where: {
        userId,
        scope: "PERSONAL",
        periodStart: { lte: weekStart },
        periodEnd: { gte: weekStart },
        currency,
      },
    }),
  ]);

  const totalExpense = sumExpense(thisWeek);
  const totalIncome = sumIncome(thisWeek);
  const expenseChangePct = percentChange(totalExpense, sumExpense(prevWeek));
  const incomeChangePct = percentChange(totalIncome, sumIncome(prevWeek));

  // Desglose por categoría (solo EXPENSE, sin "No considerar"), top 4 + "Otras".
  const byCategory = new Map<string, WeeklyCategoryBreakdown>();
  for (const t of thisWeek) {
    if (t.type !== "EXPENSE" || t.categoryName === "No considerar") continue;
    const key = t.categoryId ?? "sin-categoria";
    const entry = byCategory.get(key) ?? {
      name: t.categoryName ?? "Sin categoría",
      icon: t.categoryIcon ?? FALLBACK_CATEGORY_ICON,
      colorHex: t.categoryColor ?? "#999999",
      amount: 0,
    };
    entry.amount += t.amount;
    byCategory.set(key, entry);
  }
  const sortedCategories = [...byCategory.values()].sort((a, b) => b.amount - a.amount);
  const top4 = sortedCategories.slice(0, 4);
  const othersTotal = sortedCategories.slice(4).reduce((acc, c) => acc + c.amount, 0);
  const categoryBreakdown: WeeklyCategoryBreakdown[] =
    othersTotal > 0 ? [...top4, { name: "Otras", icon: OTHER_CATEGORY_ICON, colorHex: "#B8BEC7", amount: othersTotal }] : top4;

  // Gasto por día, Lunes a Domingo de esta semana (misma exclusión de "No considerar").
  const dayTotals = WEEKDAY_LABELS_ES.map((label) => ({ label, amount: 0 }));
  for (const t of thisWeek) {
    if (t.type !== "EXPENSE" || t.categoryName === "No considerar") continue;
    const { weekday } = toLimaParts(t.occurredAt);
    const mondayIndexed = (weekday + 6) % 7; // 0 = lunes ... 6 = domingo
    dayTotals[mondayIndexed].amount += t.amount;
  }
  let peakDayIndex: number | null = null;
  dayTotals.forEach((d, i) => {
    if (d.amount > 0 && (peakDayIndex === null || d.amount > dayTotals[peakDayIndex].amount)) peakDayIndex = i;
  });

  const weeklyBudget = budget ? Number(budget.totalAmount) / 4.345 : null;

  const topCategory =
    sortedCategories.length > 0 && totalExpense > 0
      ? {
          name: sortedCategories[0].name,
          icon: sortedCategories[0].icon,
          amount: sortedCategories[0].amount,
          pct: Math.round((sortedCategories[0].amount / totalExpense) * 100),
        }
      : null;

  const peakDay = peakDayIndex !== null ? { label: dayTotals[peakDayIndex].label, amount: dayTotals[peakDayIndex].amount } : null;

  return {
    userName,
    weekStart,
    weekEnd,
    weekLabel: formatWeekLabel(weekStart),
    currency,
    totalExpense,
    totalIncome,
    expenseChangePct,
    incomeChangePct,
    categoryBreakdown,
    dayTotals,
    peakDayIndex,
    weeklyBudget,
    topCategory,
    peakDay,
    hasAnyMovement: thisWeek.length > 0,
  };
}
