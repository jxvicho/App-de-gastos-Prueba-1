import { sendImageMessage, sendTextMessage } from "./whatsapp";
import { buildWeeklyReportData } from "./weeklyReportData";
import { buildWeeklyReportImage } from "./weeklyReportImage";

/**
 * Genera y manda el reporte semanal a UN usuario para el rango
 * [weekStart, weekEnd) que decida el caller — el worker del cron dominical
 * y el comando manual por WhatsApp ("mandame el resumen semanal") comparten
 * esta misma función para no duplicar la lógica de armar+mandar el reporte.
 * Si no hubo ningún movimiento confirmado en el rango, manda un texto
 * simple en vez de generar una imagen vacía.
 */
export async function sendWeeklyReportToUser(
  user: { id: string; name: string; phoneNumber: string | null },
  weekStart: Date,
  weekEnd: Date
): Promise<void> {
  if (!user.phoneNumber) return;

  const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd);

  if (!data.hasAnyMovement) {
    await sendTextMessage(user.phoneNumber, `Hola ${user.name}, sin movimientos esta semana (${data.weekLabel}). 👍`);
    return;
  }

  const image = buildWeeklyReportImage(data);
  await sendImageMessage(user.phoneNumber, image, `📊 Tu resumen semanal — ${data.weekLabel}`);
}
