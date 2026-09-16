import { readFileSync } from "fs";
import { join } from "path";
import { PetType } from "@prisma/client";
import { sendImageMessage, sendTextMessage } from "./whatsapp";
import { buildWeeklyReportData, getCurrenciesWithMovement } from "./weeklyReportData";
import { buildWeeklyReportImage } from "./weeklyReportImage";

// Orden fijo de envío cuando hay movimiento en ambas monedas — PEN primero
// por ser la moneda por defecto de la app.
const CURRENCY_ORDER = ["PEN", "USD"];

function currencyLabel(currency: string): string {
  return currency === "USD" ? "$ Dólares" : "S/ Soles";
}

// Cacheados en memoria: el PNG de cada mascota no cambia en caliente, no
// tiene sentido releerlo del disco en cada reporte mandado.
const mascotPngCache = new Map<string, Buffer>();
function loadMascotPng(petType: string): Buffer {
  let buf = mascotPngCache.get(petType);
  if (!buf) {
    // __dirname es dist/services (o src/services corriendo con tsx) — subimos
    // 3 niveles hasta la raíz del proyecto, donde vive public/.
    buf = readFileSync(join(__dirname, "..", "..", "public", "assets", "mascots", `${petType}.png`));
    mascotPngCache.set(petType, buf);
  }
  return buf;
}

function petGreeting(petName: string | null): string {
  return `¡Hola! Soy ${petName || "tu mascota"} 🐾, tu mascota de Gastia.`;
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

  const hasPet = user.petType !== "none";

  // Mascota: se manda ANTES que el resto del reporte, como una imagen aparte
  // sin caption propio — el saludo va en el caption del reporte (o del texto
  // "sin movimientos"), no acá, para no repetirlo en 2 mensajes. Nunca toca
  // las notificaciones de gasto individuales, solo estos 2 mensajes
  // programados.
  if (hasPet) {
    await sendImageMessage(user.phoneNumber, loadMascotPng(user.petType));
  }
  const greetingPrefix = hasPet ? `${petGreeting(user.petName)}\n` : "";

  const currenciesPresent = await getCurrenciesWithMovement(user.id, weekStart, weekEnd);

  if (currenciesPresent.length === 0) {
    const data = await buildWeeklyReportData(user.id, user.name, weekStart, weekEnd, "PEN");
    await sendTextMessage(
      user.phoneNumber,
      `${greetingPrefix}Hola ${user.name}, sin movimientos esta semana (${data.weekLabel}). 👍`
    );
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
    await sendImageMessage(user.phoneNumber, image, caption);
  }
}
