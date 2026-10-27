import { PetType } from "@prisma/client";
import { env } from "../config/env";
import { isWindowOpen, sendTemplateMessage, sendTextMessage, sanitizeTemplateParam } from "./whatsapp";
import {
  buildWeeklyReportData,
  countPendingTransactions,
  currentDayStart,
  formatMoneyPlain,
  getCurrenciesWithMovement,
} from "./weeklyReportData";
import { petIntroPhrase } from "../utils/pet";
import { prisma } from "../config/prisma";
import { takePendingAlerts } from "./alerts";

const CURRENCY_ORDER = ["PEN", "USD"];

/**
 * Reporte diario (se envía a las 9:00 de Lima): lo gastado AYER (día completo, de 00:00 a 00:00 de
 * Lima) más los movimientos pendientes de confirmar. Si ayer no hubo movimientos no se manda nada
 * (cada plantilla enviada tiene costo).
 * Dentro de la ventana de 24 h va como texto libre; fuera, como plantilla.
 */
export async function sendDailyReportToUser(user: {
  id: string;
  name: string;
  phoneNumber: string | null;
  petType: PetType;
  petName: string | null;
}): Promise<boolean> {
  if (!user.phoneNumber) return false;

  const now = new Date();
  const dayEnd = currentDayStart(now); // hoy 00:00 Lima
  const dayStart = new Date(dayEnd.getTime() - 24 * 3_600_000); // ayer 00:00 Lima
  const present = await getCurrenciesWithMovement(user.id, dayStart, dayEnd);
  const currencies = CURRENCY_ORDER.filter((c) => present.includes(c));
  const pending = await countPendingTransactions(user.id);
  // Solo se envía si ayer hubo movimientos (los pendientes por sí solos no alcanzan).
  if (currencies.length === 0) return false;

  // Alertas que no pudieron salir en su momento (ventana de 24 h cerrada): van en este resumen.
  const alerts = await takePendingAlerts(user.id);
  const movementsToday = await prisma.transaction.count({
    where: {
      userId: user.id,
      status: { in: ["CONFIRMED", "AUTO_CONFIRMED"] },
      deletedAt: null,
      occurredAt: { gte: dayStart, lt: dayEnd },
    },
  });

  let totals: string[] = [];
  let topCategory: string | null = null;
  for (const currency of currencies) {
    const data = await buildWeeklyReportData(user.id, user.name, dayStart, dayEnd, currency);
    if (data.totalExpense > 0) totals.push(formatMoneyPlain(data.totalExpense, currency));
    if (!topCategory && data.topCategory) topCategory = `${data.topCategory.icon} ${data.topCategory.name}`;
  }
  const totalLabel = totals.length ? totals.join(" y ") : formatMoneyPlain(0, "PEN");
  const firstName = user.name.trim().split(/\s+/)[0] || "Hola";

  // Los avisos van en una sola línea (las variables de plantilla no admiten saltos de línea).
  const avisos = alerts.length ? alerts.map((a) => a.replace(/^[^\p{L}\p{N}]+/u, "")).join("; ") : "ninguno";
  const petIntro = petIntroPhrase(user.petType, user.petName);
  const vars = [firstName, petIntro, String(movementsToday), totalLabel, topCategory ?? "ninguna", String(pending), avisos];

  if (await isWindowOpen(user.phoneNumber)) {
    // Mismo texto que el cuerpo de la plantilla aprobada (docs/plantillas-whatsapp.md).
    const [n, p, m, t, c, pe, av] = vars.map((v) => sanitizeTemplateParam(v));
    await sendTextMessage(
      user.phoneNumber,
      `Hola ${n}, soy ${p}. Ayer registraste ${m} movimientos por ${t} y tu categoría con más gasto fue ${c}. ` +
        `Pendientes por confirmar: ${pe}. Avisos: ${av}. Revisa el detalle en tu dashboard de Gastia.`,
      { kind: "daily_summary" }
    );
  } else {
    await sendTemplateMessage(user.phoneNumber, env.WHATSAPP_TEMPLATE_DAILY, env.WHATSAPP_TEMPLATE_LANG, vars, { kind: "daily_summary" });
  }
  return true;
}
