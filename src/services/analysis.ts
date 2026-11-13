import { prisma } from "../config/prisma";
import { merchantKeyOf } from "./recurringDetect";

/**
 * Datos de la pestaña Análisis. Todo se calcula aquí (hora de Lima, solo movimientos confirmados, sin categorías
 * que no cuentan en los totales) y el dashboard solo dibuja. Un solo viaje al servidor por pantalla.
 */

const LIMA_OFFSET_MS = 5 * 3_600_000;
const COUNTED = ["CONFIRMED", "AUTO_CONFIRMED"] as const;
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Los movimientos de correo guardan la hora de Lima como si fuera UTC; los manuales guardan el instante real. */
function wall(t: { occurredAt: Date; source?: string | null }): Date {
  return String(t.source ?? "").startsWith("EMAIL") ? t.occurredAt : new Date(t.occurredAt.getTime() - LIMA_OFFSET_MS);
}
const ymKey = (y: number, m: number) => y * 12 + m;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export interface SavingsGoalRow {
  id: string;
  name: string;
  currency: string;
  target: number;
  saved: number;
  initialSaved: number;
  mode: "DATE" | "AMOUNT";
  targetMonth: string | null;
  monthlyAmount: number | null;
  startedAt: string;
  contributions: { id: string; amount: number; paidAt: string }[];
}

export async function loadSavingsGoals(userId: string): Promise<SavingsGoalRow[]> {
  const rows = await prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { contributions: { orderBy: { paidAt: "desc" } } },
  });
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    currency: g.currency,
    target: Number(g.targetAmount),
    saved: r2(Number(g.initialSaved) + g.contributions.reduce((s, c) => s + Number(c.amount), 0)),
    initialSaved: Number(g.initialSaved),
    mode: g.mode === "AMOUNT" ? "AMOUNT" : "DATE",
    targetMonth: g.targetMonth,
    monthlyAmount: g.monthlyAmount === null ? null : Number(g.monthlyAmount),
    startedAt: g.startedAt.toISOString(),
    contributions: g.contributions.slice(0, 5).map((c) => ({ id: c.id, amount: Number(c.amount), paidAt: c.paidAt.toISOString() })),
  }));
}

export async function buildAnalysis(userId: string, currency: "PEN" | "USD") {
  const now = new Date();
  const L = new Date(now.getTime() - LIMA_OFFSET_MS);
  const y = L.getUTCFullYear(), m = L.getUTCMonth(), today = L.getUTCDate();
  const dim = daysIn(y, m);
  const prevY = m === 0 ? y - 1 : y, prevM = m === 0 ? 11 : m - 1;
  const prevDim = daysIn(prevY, prevM);
  const daysLeft = dim - today;

  // Ventana: 7 meses atrás (ingreso promedio) con 1 día de holgura; el recorte fino se hace con la hora de pared.
  const since = new Date(Date.UTC(y, m - 7, 1, 0, 0, 0));
  const [txns, recurring, budget, goals, debts, savings] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, currency, status: { in: [...COUNTED] }, deletedAt: null, occurredAt: { gte: since }, category: { excludeFromTotals: false } },
      select: { type: true, amount: true, merchant: true, description: true, occurredAt: true, source: true, categoryId: true, category: { select: { id: true, name: true } } },
    }),
    prisma.recurringPayment.findMany({ where: { userId, currency, ignored: false, isActive: true } }),
    prisma.budget.findFirst({ where: { userId, scope: "PERSONAL", currency, periodStart: { lte: now }, periodEnd: { gte: now } } }),
    prisma.categoryGoal.findMany({ where: { userId, currency } }),
    prisma.debt.findMany({ where: { userId, currency, direction: "PAYABLE", settledAt: null }, include: { payments: true } }),
    loadSavingsGoals(userId),
  ]);

  const nameOf = (t: { merchant: string | null; description: string | null }) => (t.merchant || t.description || "Movimiento").trim();
  const recKeys = new Map(recurring.map((r) => [r.merchantKey || merchantKeyOf(r.merchant), r]));
  const keyOf = (t: { merchant: string | null; description: string | null }) => merchantKeyOf(nameOf(t));

  // ---------- gastos por día (este mes y el anterior) ----------
  const daily = new Array(today).fill(0) as number[];
  const prevDaily = new Array(prevDim).fill(0) as number[];
  const catThis = new Map<string, { id: string; name: string; used: number; prevSame: number; prevFull: number; fixedUsed: number }>();
  const catRow = (id: string, name: string) => {
    let c = catThis.get(id);
    if (!c) { c = { id, name, used: 0, prevSame: 0, prevFull: 0, fixedUsed: 0 }; catThis.set(id, c); }
    return c;
  };
  let spentFixed = 0;
  const chargedKeys = new Set<string>();
  const incomeByMonth = new Map<number, number>();
  const incomeItemsByMonth = new Map<number, Map<string, number[]>>();
  const thisMonthIncome: { name: string; key: string; amount: number }[] = [];
  const last30: { key: string; name: string; amount: number }[] = [];

  for (const t of txns) {
    const w = wall(t);
    const ty = w.getUTCFullYear(), tm = w.getUTCMonth(), td = w.getUTCDate();
    const amount = Number(t.amount);
    const k = ymKey(ty, tm);
    if (t.type === "INCOME") {
      incomeByMonth.set(k, (incomeByMonth.get(k) ?? 0) + amount);
      const key = keyOf(t);
      const byKey = incomeItemsByMonth.get(k) ?? new Map<string, number[]>();
      byKey.set(key, [...(byKey.get(key) ?? []), amount]);
      incomeItemsByMonth.set(k, byKey);
      if (ty === y && tm === m) thisMonthIncome.push({ name: nameOf(t), key, amount });
      continue;
    }
    const catId = t.category?.id ?? "none";
    const catName = t.category?.name ?? "Sin categoría";
    if (ty === y && tm === m) {
      if (td <= today) daily[td - 1] += amount;
      const key = keyOf(t);
      const isFixed = recKeys.has(key);
      if (isFixed) { spentFixed += amount; chargedKeys.add(key); }
      const c = catRow(catId, catName);
      c.used += amount;
      if (isFixed) c.fixedUsed += amount;
    } else if (ty === prevY && tm === prevM) {
      prevDaily[td - 1] += amount;
      const c = catRow(catId, catName);
      c.prevFull += amount;
      if (td <= today) c.prevSame += amount;
    }
    // últimos 30 días (para gastos hormiga)
    const ageDays = (Date.UTC(y, m, today) - Date.UTC(ty, tm, td)) / 86_400_000;
    if (ageDays >= 0 && ageDays < 30) last30.push({ key: keyOf(t), name: nameOf(t), amount });
  }

  const spent = daily.reduce((a, b) => a + b, 0);
  const spentVariable = Math.max(0, spent - spentFixed);

  // ---------- pagos fijos que faltan ----------
  const fixedPending = recurring
    .filter((r) => !chargedKeys.has(r.merchantKey || merchantKeyOf(r.merchant)))
    .map((r) => {
      const day = Math.min(r.dayOfMonth, dim);
      return { id: r.id, name: r.merchant, amount: Number(r.amount), day, late: day <= today };
    })
    .sort((a, b) => a.day - b.day);
  const fixedPendingTotal = r2(fixedPending.reduce((s, f) => s + f.amount, 0));
  const fixedMonthlyTotal = r2(recurring.reduce((s, r) => s + Number(r.amount), 0));

  // ---------- categorías: este mes frente al anterior (mismo día) ----------
  const goalBy = new Map(goals.map((g) => [g.categoryId, Number(g.amount)]));
  const categories = [...catThis.values()]
    .filter((c) => c.used > 0 || goalBy.has(c.id))
    .map((c) => {
      const fixed = c.used > 0 && c.fixedUsed / c.used >= 0.8;
      const projected = fixed ? c.used : (c.used / Math.max(1, today)) * dim;
      return { id: c.id, name: c.name, used: r2(c.used), prevSame: r2(c.prevSame), prevFull: r2(c.prevFull), budget: goalBy.get(c.id) ?? null, projected: r2(projected), fixed };
    })
    .sort((a, b) => b.used - a.used)
    .slice(0, 7);

  // ---------- ingreso ----------
  const kThis = ymKey(y, m);
  const prevKeys = [1, 2, 3, 4, 5, 6].map((i) => kThis - i);
  const histIncome = prevKeys.map((k) => incomeByMonth.get(k) ?? 0).reverse(); // del más viejo al más reciente
  // Un ingreso es "sueldo" (se repite) si el mismo origen aparece en 3 o más de los últimos 6 meses.
  const monthsSeen = new Map<string, number[]>();
  for (const k of [kThis, ...prevKeys]) {
    for (const [key, arr] of incomeItemsByMonth.get(k) ?? []) {
      if (!key) continue;
      monthsSeen.set(key, [...(monthsSeen.get(key) ?? []), arr.reduce((a, b) => a + b, 0)]);
    }
  }
  const recurringIncome = new Set([...monthsSeen].filter(([, v]) => v.length >= 3).map(([key]) => key));
  const baseSalary = r2([...recurringIncome].reduce((s, key) => s + median(monthsSeen.get(key)!), 0));
  const incomeItems = thisMonthIncome
    .sort((a, b) => b.amount - a.amount)
    .map((i) => ({ name: i.name, amount: r2(i.amount), kind: recurringIncome.has(i.key) ? "SALARY" : "EXTRA" }));
  const histWith = histIncome.filter((v) => v > 0);
  const incomeThisMonth = r2(incomeByMonth.get(kThis) ?? 0);

  // ---------- compromisos del mes ----------
  const debtsDue = debts
    .filter((d) => d.dueDate && ymKey(d.dueDate.getUTCFullYear(), d.dueDate.getUTCMonth()) <= kThis)
    .reduce((s, d) => s + Math.max(0, Number(d.amount) - d.payments.reduce((a, p) => a + Number(p.amount), 0)), 0);

  // ---------- gastos hormiga y suscripciones ----------
  const group = new Map<string, { name: string; n: number; total: number }>();
  for (const t of last30) {
    if (!t.key || recKeys.has(t.key)) continue;
    const g = group.get(t.key) ?? { name: t.name, n: 0, total: 0 };
    g.n += 1; g.total += t.amount; group.set(t.key, g);
  }
  const ants: { id: string; name: string; note: string; monthly: number; kind: "ANT" | "SUB"; isNew: boolean }[] = [];
  for (const [key, g] of group) {
    const avg = g.total / g.n;
    if (g.n >= 4 && avg <= 30) ants.push({ id: key, name: g.name, note: `${g.n} compras, promedio ${currency === "USD" ? "$" : "S/"} ${avg.toFixed(0)}`, monthly: r2(g.total), kind: "ANT", isNew: false });
  }
  for (const r of recurring) {
    const amt = Number(r.amount);
    if (amt <= 100) {
      const isNew = r.source === "DETECTED" && now.getTime() - r.detectedAt.getTime() < 45 * 86_400_000;
      ants.push({ id: r.id, name: r.merchant, note: isNew ? "Cobro mensual nuevo" : "Cobro mensual", monthly: r2(amt), kind: "SUB", isNew });
    }
  }
  ants.sort((a, b) => b.monthly - a.monthly);

  // ---------- lo que Gastia notó ----------
  const insights: { tone: "warn" | "ok"; tag: string; text: string }[] = [];
  const cmp = categories.filter((c) => !c.fixed && c.prevSame >= 20).map((c) => ({ c, pct: ((c.used - c.prevSame) / c.prevSame) * 100 }));
  const up = [...cmp].sort((a, b) => b.pct - a.pct)[0];
  const down = [...cmp].sort((a, b) => a.pct - b.pct)[0];
  const sym = currency === "USD" ? "$" : "S/";
  const money = (n: number) => `${sym} ${Math.round(n).toLocaleString("en-US")}`;
  if (up && up.pct > 15) insights.push({ tone: "warn", tag: "Más que el mes pasado", text: `Gastaste ${Math.round(up.pct)} % más en ${up.c.name} que el mes pasado a esta altura (${money(up.c.used)} contra ${money(up.c.prevSame)}).` });
  if (down && down.pct < -10) insights.push({ tone: "ok", tag: "Mejoró", text: `Tu gasto en ${down.c.name} bajó ${Math.round(-down.pct)} % frente al mes pasado (${money(down.c.used)} contra ${money(down.c.prevSame)}).` });
  const newSub = ants.find((a) => a.kind === "SUB" && a.isNew);
  if (newSub) insights.push({ tone: "warn", tag: "Cobro nuevo", text: `Apareció un cobro mensual de ${sym} ${newSub.monthly.toFixed(2)} en ${newSub.name}.` });

  return {
    currency,
    month: { year: y, month: m, label: MONTHS_ES[m], prevLabel: MONTHS_ES[prevM], daysInMonth: dim, today, daysLeft },
    budget: budget ? Number(budget.totalAmount) || null : null,
    spent: r2(spent),
    spentFixed: r2(spentFixed),
    spentVariable: r2(spentVariable),
    daily: daily.map(r2),
    prevDaily: prevDaily.map(r2),
    fixedPending,
    fixedPendingTotal,
    fixedMonthlyTotal,
    fixedAll: recurring.map((r) => ({ name: r.merchant, amount: Number(r.amount), day: Math.min(r.dayOfMonth, dim) })),
    income: { thisMonth: incomeThisMonth, baseSalary, items: incomeItems, history: histIncome.map(r2), avg6: histWith.length ? r2(histWith.reduce((a, b) => a + b, 0) / histWith.length) : null },
    debtsDue: r2(debtsDue),
    categories,
    ants: ants.slice(0, 6),
    savings,
    insights,
  };
}
