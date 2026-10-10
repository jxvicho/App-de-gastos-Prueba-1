import { PetType } from "@prisma/client";
import { env } from "../config/env";
import { isWindowOpen, sendImageMessage, sendTemplateWithImage, sendTextMessage } from "./whatsapp";
import {
  buildWeeklyReportData,
  countPendingTransactions,
  formatMoneyPlain,
  getCurrenciesWithMovement,
} from "./weeklyReportData";
import { buildWeeklyReportImage } from "./weeklyReportImage";
import { getPetLabel, PetPersona } from "../utils/pet";

// Orden fijo de envío cuando hay movimiento en ambas monedas — PEN primero
// por ser la moneda por defecto de la app.
const CURRENCY_ORDER = ["PEN", "USD"];

function currencyLabel(currency: string): string {
  return currency === "USD" ? "$ Dólares" : "S/ Soles";
}

// El emoji ahora viene de `pet.emoji` (según la mascota real elegida:
// 🐶/🐱/🦫/🐷) en vez de la patita "🐾" fija de antes.
function petGreeting(pet: PetPersona): string {
  return `¡Hola! Soy ${pet.name} ${pet.emoji}, tu mascota de Gastia.`;
}

/**
 * Genera y manda el/los reporte(s) semanal(es) a UN usuario para el rango
 * [weekStart, weekEnd) que decida el caller — el worker del cron dominical
 * y el comando manual por WhatsApp ("mandame el resumen semanal") comparten
 * esta misma función para no duplicar la lógica de armar+mandar el reporte.
 *
 * Soles y dólares nunca se mezclan en un solo reporte: se revisa qué
 * moneda(s) tuvieron movimiento confirmado esa semana y se manda un reporte
 * (una imagen) separado por cada una, en mensajes consecutivos. Si no hubo
 * movimiento en ninguna moneda, se manda un solo texto simple en soles (el
 * fallback histórico) en vez de generar una imagen vacía.
 */
export async function sendWeeklyReportToUser(
  user: { id: string; name: string; phoneNumber: string | null; petType: PetType; petName: string | null },
  weekStart: Date,
  weekEnd: Date
): Promise<void> {
  if (!user.phoneNumber) return;

  const pet = getPetLabel(user.petType, user.petName);

  // El saludo de la mascota va como texto al inicio del caption del reporte
  // (o del mensaje "sin movimientos") — ya no se manda la imagen de la
  // mascota por separado. Nunca toca las notificaciones de gasto
  // individuales, solo estos 2 mensajes programados.
  const greetingPrefix = pet ? `${petGreeting(pet)}\n` : "";

  const currenciesPresent = await getCurrenciesWithMovement(user.id, weekStart, weekEnd);

  // Dentro de las 24 h de la última escritura del usuario se manda texto/imagen
  // libre; fuera, Meta solo acepta una plantilla aprobada (docs/plantillas-whatsapp.md).
  const windowOpen = await isWindowOpen(user.phoneNumber);
  const firstName = user.name.trim().split(/\s+/)[0] || "Hola";

  if (currenciesPresent.length === 0) {
    const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd, "PEN");
    if (windowOpen) {
      await sendTextMessage(
        user.phoneNumber,
        `${greetingPrefix}Hola ${user.name}, sin movimientos esta semana (${data.weekLabel}). 👍`,
        { kind: "weekly_report" }
      );
    } else {
      const pending = await countPendingTransactions(user.id);
      // La plantilla lleva imagen en el encabezado: se manda el reporte vacío.
      await sendTemplateWithImage(
        user.phoneNumber,
        env.WHATSAPP_TEMPLATE_WEEKLY,
        env.WHATSAPP_TEMPLATE_LANG,
        buildWeeklyReportImage(data),
        [firstName, data.weekLabel, formatMoneyPlain(0, "PEN"), "ninguna", String(pending)],
        { kind: "weekly_report" }
      );
    }
    return;
  }

  const currencies = CURRENCY_ORDER.filter((c) => currenciesPresent.includes(c));
  const sendSeparateLabel = currencies.length > 1;

  for (let i = 0; i < currencies.length; i++) {
    const currency = currencies[i];
    const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd, currency);
    const image = buildWeeklyReportImage(data);
    // El saludo solo va una vez (primer mensaje) aunque se manden 2 reportes
    // separados por moneda — repetirlo en ambos sería ruido.
    const prefix = i === 0 ? greetingPrefix : "";
    const caption = sendSeparateLabel
      ? `${prefix}📊 Tu resumen semanal — ${currencyLabel(currency)} — ${data.weekLabel}`
      : `${prefix}📊 Tu resumen semanal — ${data.weekLabel}`;
    if (windowOpen) {
      await sendImageMessage(user.phoneNumber, image, caption, { kind: "weekly_report" });
    } else {
      const pending = await countPendingTransactions(user.id);
      await sendTemplateWithImage(user.phoneNumber, env.WHATSAPP_TEMPLATE_WEEKLY, env.WHATSAPP_TEMPLATE_LANG, image, [
        firstName,
        data.weekLabel,
        formatMoneyPlain(data.totalExpense, currency),
        data.topCategory?.name ?? "ninguna",
        String(pending),
      ], { kind: "weekly_report" });
    }
  }
}
