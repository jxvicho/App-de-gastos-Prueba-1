import { sendImageMessage, sendTextMessage } from "./whatsapp";
import { buildWeeklyReportData, getCurrenciesWithMovement } from "./weeklyReportData";
import { buildWeeklyReportImage } from "./weeklyReportImage";

// Orden fijo de envío cuando hay movimiento en ambas monedas — PEN primero
// por ser la moneda por defecto de la app.
const CURRENCY_ORDER = ["PEN", "USD"];

function currencyLabel(currency: string): string {
  return currency === "USD" ? "$ Dólares" : "S/ Soles";
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
  user: { id: string; name: string; phoneNumber: string | null },
  weekStart: Date,
  weekEnd: Date
): Promise<void> {
  if (!user.phoneNumber) return;

  const currenciesPresent = await getCurrenciesWithMovement(user.id, weekStart, weekEnd);

  if (currenciesPresent.length === 0) {
    const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd, "PEN");
    await sendTextMessage(user.phoneNumber, `Hola ${user.name}, sin movimientos esta semana (${data.weekLabel}). 👍`);
    return;
  }

  const currencies = CURRENCY_ORDER.filter((c) => currenciesPresent.includes(c));
  const sendSeparateLabel = currencies.length > 1;

  for (const currency of currencies) {
    const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd, currency);
    const image = buildWeeklyReportImage(data);
    const caption = sendSeparateLabel
      ? `📊 Tu resumen semanal — ${currencyLabel(currency)} — ${data.weekLabel}`
      : `📊 Tu resumen semanal — ${data.weekLabel}`;
    await sendImageMessage(user.phoneNumber, image, caption);
  }
}
