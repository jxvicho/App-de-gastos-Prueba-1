import { PetType } from "@prisma/client";
import { env } from "../config/env";
import { isWindowOpen, sendTemplateMessage, sendTextMessage } from "./whatsapp";
import {
  buildWeeklyReportData,
  countPendingTransactions,
  currentDayStart,
  formatMoneyPlain,
  getCurrenciesWithMovement,
} from "./weeklyReportData";
import { getPetLabel } from "../utils/pet";

const CURRENCY_ORDER = ["PEN", "USD"];

/**
 * Reporte diario: lo gastado HOY (desde las 00:00 de Lima hasta ahora) más
 * los movimientos pendientes de confirmar. Si hoy no hubo gastos ni hay
 * pendientes no se manda nada (cada plantilla enviada tiene costo).
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

  const dayStart = currentDayStart();
  const now = new Date();
  const present = await getCurrenciesWithMovement(user.id, dayStart, now);
  const currencies = CURRENCY_ORDER.filter((c) => present.includes(c));
  const pending = await countPendingTransactions(user.id);
  // Solo se envía en días con movimientos (los pendientes por sí solos no alcanzan).
  if (currencies.length === 0) return false;

  let totals: string[] = [];
  let topCategory: string | null = null;
  for (const currency of currencies) {
    const data = await buildWeeklyReportData(user.id, user.name, dayStart, now, currency);
    if (data.totalExpense > 0) totals.push(formatMoneyPlain(data.totalExpense, currency));
    if (!topCategory && data.topCategory) topCategory = `${data.topCategory.icon} ${data.topCategory.name}`;
  }
  const totalLabel = totals.length ? totals.join(" y ") : formatMoneyPlain(0, "PEN");
  const firstName = user.name.trim().split(/\s+/)[0] || "Hola";

  if (await isWindowOpen(user.phoneNumber)) {
    const pet = getPetLabel(user.petType, user.petName);
    const lines = [
      `${pet ? `¡Hola! Soy ${pet.name} ${pet.emoji}. ` : ""}📅 Tu resumen de hoy, ${firstName}:`,
      `• Gastaste ${totalLabel}`,
      topCategory ? `• Categoría con más gasto: ${topCategory}` : null,
      pending > 0 ? `• Tienes ${pending} movimiento${pending === 1 ? "" : "s"} pendiente${pending === 1 ? "" : "s"} de confirmar. Escribe "pendientes" para verlos.` : null,
    ].filter(Boolean);
    await sendTextMessage(user.phoneNumber, lines.join("\n"), { kind: "daily_summary" });
  } else {
    await sendTemplateMessage(user.phoneNumber, env.WHATSAPP_TEMPLATE_DAILY, env.WHATSAPP_TEMPLATE_LANG, [
      firstName,
      totalLabel,
      topCategory ?? "ninguna",
      String(pending),
    ], { kind: "daily_summary" });
  }
  return true;
}
