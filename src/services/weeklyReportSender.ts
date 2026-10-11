import { PetType } from "@prisma/client";
import { env } from "../config/env";
import { isWindowOpen, sendImageMessage, sendTemplateWithImage, sanitizeTemplateParam } from "./whatsapp";
import {
  buildWeeklyReportData,
  countPendingTransactions,
  formatMoneyPlain,
  getCurrenciesWithMovement,
} from "./weeklyReportData";
import { buildWeeklyReportImage } from "./weeklyReportImage";
import { petIntroPhrase } from "../utils/pet";

// Orden fijo de envío cuando hay movimiento en ambas monedas — PEN primero
// por ser la moneda por defecto de la app.
const CURRENCY_ORDER = ["PEN", "USD"];

/**
 * Texto del reporte semanal. Es EXACTAMENTE el cuerpo de la plantilla aprobada
 * (docs/plantillas-whatsapp.md): dentro de la ventana de 24 h se manda como pie
 * de la imagen y fuera de ella como cuerpo de la plantilla, para que el usuario
 * reciba lo mismo en ambos casos.
 */
function weeklyBody(v: { firstName: string; petIntro: string; weekLabel: string; total: string; top: string; pending: number }): string {
  const c = sanitizeTemplateParam;
  return (
    `Hola ${c(v.firstName)}, soy ${c(v.petIntro)}. Este es tu resumen semanal (${c(v.weekLabel)}): ` +
    `gastaste ${c(v.total)} y tu categoría con más gasto fue ${c(v.top)}. ` +
    `Tienes ${v.pending} movimientos pendientes de confirmar. Revisa el detalle en tu dashboard de Gastia.`
  );
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
 * movimiento en ninguna moneda, se manda el reporte vacío en soles.
 */
export async function sendWeeklyReportToUser(
  user: { id: string; name: string; phoneNumber: string | null; petType: PetType; petName: string | null },
  weekStart: Date,
  weekEnd: Date
): Promise<void> {
  if (!user.phoneNumber) return;

  const currenciesPresent = await getCurrenciesWithMovement(user.id, weekStart, weekEnd);

  // Dentro de las 24 h de la última escritura del usuario se manda imagen con pie de foto; fuera,
  // Meta solo acepta la plantilla aprobada. Ambos llevan la misma imagen y el mismo texto.
  const windowOpen = await isWindowOpen(user.phoneNumber);
  const firstName = user.name.trim().split(/\s+/)[0] || "Hola";
  const petIntro = petIntroPhrase(user.petType, user.petName);
  const pending = await countPendingTransactions(user.id);

  // Sin movimientos en ninguna moneda: se manda el reporte vacío en soles.
  const currencies = currenciesPresent.length === 0 ? ["PEN"] : CURRENCY_ORDER.filter((c) => currenciesPresent.includes(c));

  for (const currency of currencies) {
    const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd, currency);
    const image = buildWeeklyReportImage(data);
    const total = formatMoneyPlain(data.totalExpense, currency);
    const top = data.topCategory?.name ?? "ninguna";
    if (windowOpen) {
      await sendImageMessage(
        user.phoneNumber,
        image,
        weeklyBody({ firstName, petIntro, weekLabel: data.weekLabel, total, top, pending }),
        { kind: "weekly_report" }
      );
    } else {
      await sendTemplateWithImage(
        user.phoneNumber,
        env.WHATSAPP_TEMPLATE_WEEKLY,
        env.WHATSAPP_TEMPLATE_LANG,
        image,
        [firstName, petIntro, data.weekLabel, total, top, String(pending)],
        { kind: "weekly_report" }
      );
    }
  }
}
