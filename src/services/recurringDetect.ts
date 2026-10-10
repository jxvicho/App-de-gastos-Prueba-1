import { prisma } from "../config/prisma";
import { normalizeText } from "../utils/text";

/** Clave estable de un comercio: minúsculas, sin tildes, sin números ni símbolos. */
export function merchantKeyOf(raw: string): string {
  return normalizeText(raw).replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

const MONTHS_BACK = 6;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Detecta pagos fijos mensuales a partir de los movimientos confirmados de los
 * últimos 6 meses: mismo comercio, mismo monto (±10 %) y mismo día del mes
 * (±5 días) en 3 o más meses distintos — o en 2 meses seguidos si el monto casi
 * no cambia (±2 %) y el día coincide (±3). No toca lo que el usuario ya editó o
 * quitó (ignored). Devuelve cuántos pagos nuevos se agregaron.
 */
export async function detectRecurringPayments(userId: string): Promise<number> {
  const since = new Date();
  since.setMonth(since.getMonth() - MONTHS_BACK);

  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      type: "EXPENSE",
      status: { in: ["CONFIRMED", "AUTO_CONFIRMED"] },
      deletedAt: null,
      occurredAt: { gte: since },
      category: { excludeFromTotals: false },
    },
    select: { merchant: true, description: true, amount: true, currency: true, occurredAt: true, categoryId: true },
  });

  const groups = new Map<string, typeof txns>();
  for (const t of txns) {
    const name = (t.merchant || t.description || "").trim();
    const key = merchantKeyOf(name);
    if (key.length < 3) continue;
    const k = `${key}|${t.currency}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }

  const existing = await prisma.recurringPayment.findMany({ where: { userId } });
  const known = new Set(existing.map((r) => `${r.merchantKey}|${r.currency}`));
  let added = 0;

  for (const [k, list] of groups) {
    if (known.has(k)) continue;
    const months = new Set(list.map((t) => `${t.occurredAt.getUTCFullYear()}-${t.occurredAt.getUTCMonth()}`));
    if (months.size < 2) continue;

    const amounts = list.map((t) => Number(t.amount));
    const days = list.map((t) => new Date(t.occurredAt.getTime() - 5 * 3_600_000).getUTCDate());
    const amt = median(amounts);
    const day = Math.round(median(days));
    const amtSpread = Math.max(...amounts.map((a) => Math.abs(a - amt) / amt));
    const daySpread = Math.max(...days.map((d) => Math.abs(d - day)));

    const strong = months.size >= 3 && amtSpread <= 0.1 && daySpread <= 5;
    const tight = months.size >= 2 && amtSpread <= 0.02 && daySpread <= 3;
    if (!strong && !tight) continue;

    const last = list.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b));
    const [key, currency] = k.split("|");
    try {
      await prisma.recurringPayment.create({
        data: {
          userId,
          merchant: (last.merchant || last.description || key).trim(),
          merchantKey: key,
          amount: Math.round(amt * 100) / 100,
          currency,
          dayOfMonth: Math.min(Math.max(day, 1), 31),
          lastChargedAt: last.occurredAt,
          categoryId: last.categoryId,
          source: "DETECTED",
        },
      });
      added++;
    } catch {
      /* carrera con otra detección: se ignora */
    }
  }
  return added;
}
