import type { Transaction } from "@prisma/client";
import { prisma } from "../config/prisma";
import { sendInteractiveButtons, sendTextMessage } from "./whatsapp";
import { downloadWhatsappMedia } from "./whatsappMedia";
import { extractTransferFromImage } from "./gemini";
import { sendWeeklyReportToUser } from "./weeklyReportSender";
import { currentWeekStart } from "./weeklyReportData";
import { DEFAULT_CATEGORIES } from "../utils/defaultCategories";
import { normalizeText } from "../utils/text";

const CONFIRM_WORDS = new Set(["si", "s", "yes", "confirmar"]);
const REJECT_WORDS = new Set(["no", "n"]);

// Palabras/frases típicas de confirmación dentro de un mensaje más largo —
// "anotar" es literalmente el texto del botón "✅ Anotar" (ver BUTTON_ID_CONFIRM
// más abajo). A diferencia de CONFIRM_WORDS (que exige que el mensaje
// completo sea exactamente una de esas palabras), esto reconoce frases
// naturales como "sí anotar", "dale, anótalo", "confirmar por favor".
const CONFIRM_INTENT_PATTERNS = [
  /\bsi\b/, /\bs\b/, /\byes\b/, /\bconfirmar\b/, /\bconfirmalo\b/,
  /\banotar\b/, /\banotalo\b/, /\banotarlo\b/, /\bdale\b/, /\bok\b/, /\bokay\b/,
];

/**
 * ¿El mensaje CONTIENE una palabra/frase de confirmación típica? Excluye
 * negaciones ("no anotar", "no confirmes", "no lo registres") para no
 * confundirlas con una confirmación. NO usar esto donde haya que elegir
 * ENTRE VARIAS transacciones candidatas sin otra señal — para eso sigue
 * existiendo el chequeo estricto con CONFIRM_WORDS.has() a secas (ver el
 * fallback de "varias pendientes" en handleIncomingMessage), porque ahí sí
 * haría falta adivinar cuál de todas, y una detección más laxa reintroduciría
 * los bugs de identificación de la Fase 3.
 */
function detectConfirmWordIntent(normalizedText: string): boolean {
  const hasNegation = /\bno\s+(lo\s+)?(anot\w*|confirm\w*|regist\w*)\b/.test(normalizedText);
  if (hasNegation) return false;
  return CONFIRM_INTENT_PATTERNS.some((pattern) => pattern.test(normalizedText));
}

const BUTTON_ID_CONFIRM = "txn_confirm";
const BUTTON_ID_REJECT = "txn_reject";
const BUTTON_ID_IMAGE_EXPENSE = "img_expense";
const BUTTON_ID_IMAGE_TRANSFER = "img_transfer";
const BUTTON_ID_IMAGE_INCOME = "img_income";

// Mapeamos por nombre de categoría para no reinventar íconos que ya
// existen en el catálogo real de categorías (DEFAULT_CATEGORIES).
const CATEGORY_ICON_BY_NAME = new Map(DEFAULT_CATEGORIES.map((c) => [c.name, c.icon]));
const FALLBACK_CATEGORY_ICON = "🏷️";

const MONTH_NAMES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DAY_NAMES_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTotalsByCurrency(items: { currency: string; amount: number }[]): string {
  const totals = new Map<string, number>();
  for (const it of items) totals.set(it.currency, (totals.get(it.currency) ?? 0) + it.amount);
  return [...totals.entries()].map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(" + ");
}

// Alias/sinónimos en español (sin tildes, minúsculas) para reconocer una
// corrección de categoría escrita en texto libre, ej. "anótalo en comidas".
const CATEGORY_ALIASES: Record<string, string[]> = {
  "Yape / Plin": ["yape", "plin", "billetera digital"],
  "Alimentación": ["comida", "comidas", "super", "supermercado", "restaurante", "almuerzo", "mercado", "delivery"],
  "Servicios y utilities": ["servicios", "luz", "agua", "internet", "telefono", "celular", "utilities", "utility"],
  "Otros comercios": ["otros", "otros comercios", "comercio", "tienda"],
  Transporte: ["taxi", "uber", "pasaje", "movilidad", "transporte", "combustible", "gasolina", "grab", "cabify"],
  Salud: ["salud", "farmacia", "medico", "doctor", "clinica", "medicina", "botica"],
  "Movimientos financieros": ["transferencia", "prestamo", "tarjeta", "financiero", "financieros"],
  Ingresos: ["ingreso", "ingresos", "sueldo", "deposito", "cobro"],
  "No considerar": ["no considerar", "ignorar", "excluir"],
};

// Frases que indican intención de RECHAZAR un movimiento PENDING_CONFIRMATION
// identificado por detalles, ej. "descarta el gasto de 4 soles a Virgilio".
// Ojo: "eliminar/borrar/anular/quitar" NO están acá — esas van en
// DELETE_CONFIRMED_INTENT_PHRASES, porque son verbos que un usuario usa
// naturalmente para pedir borrar algo que YA quedó registrado (CONFIRMED),
// no para descartar algo que todavía está pendiente. Mantenerlos separados
// evita ambigüedad entre "descarta" y "elimina".
const REJECT_INTENT_PHRASES = [
  "descarta", "descartar", "no lo anotes", "no la anotes", "no anotar", "no anoto",
  "cancela", "cancelar", "ignoralo", "ignora",
];

// Frases que indican intención de ELIMINAR un gasto que YA está CONFIRMED
// (acción destructiva/irreversible — se distingue de "rechazar" un pendiente).
const DELETE_CONFIRMED_INTENT_PHRASES = [
  "eliminar", "elimina", "borrar", "borra", "anular", "anula", "anulalo",
  "deshacer", "deshaz", "quita", "quitalo", "remueve", "remover",
];

type PendingTransaction = Transaction & { category: { name: string } | null };

// Palabras de relleno que no deben tratarse como parte de un nombre de
// comercio/persona al buscar una transacción por lenguaje natural.
const DETAIL_SEARCH_STOPWORDS = new Set([
  "el", "la", "los", "las", "de", "del", "a", "al", "en", "con", "por", "para", "que", "es",
  "fue", "un", "una", "y", "o", "mi", "me", "lo", "le",
  "gasto", "gastos", "movimiento", "transaccion", "pago", "compra",
  "anotar", "anota", "anotalo", "anotarlo", "registra", "registrar", "confirmar", "confirma",
  "hoy", "ayer", "anteayer", "soles", "sol", "pen", "s",
  "este", "esta", "ese", "esa", "eso", "cual", "es", "va", "real", "seguro", "si",
  "descarta", "descartar", "borra", "borrar", "elimina", "eliminar", "cancela", "cancelar", "quita", "quitar",
  "anular", "anula", "anulalo", "deshacer", "deshaz", "quitalo", "remueve", "remover", "ignoralo", "ignora",
  // Palabras de relleno de las frases de "confirmar de nuevo" / restaurar
  // (ej. "anótalo de nuevo", "vuelve a considerarlo") — sin esto, "nuevo"
  // o "vuelve" se tratan como si fueran parte del nombre del comercio.
  "nuevo", "nuevamente", "vuelve", "volver", "registralo", "confirmalo",
  "considera", "considerar", "realidad", "otra", "vez", "favor",
  // Verbos de "recategorizar" (ver RECATEGORIZE_INTENT_VERBS) — sin esto,
  // "cambia"/"mueve"/"corrige" se tratarían como parte del nombre buscado.
  "cambia", "cambiar", "mueve", "muevelo", "mover", "corrige", "corrigelo", "corregir",
  "recategoriza", "recategorizalo", "recategorizar", "reclasifica", "reclasificalo", "reclasificar",
]);

/** Extrae del texto normalizado palabras "de contenido" (posibles nombres de comercio/persona). */
function extractNameCandidates(normalizedText: string): string[] {
  return normalizedText
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !DETAIL_SEARCH_STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Palabras de contenido de un texto libre (sin tildes, minúsculas, sin
 * puntuación), ignorando las de una sola letra — para no exigir que el
 * usuario adivine iniciales sueltas que no escribió.
 */
function toContentWords(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 1);
}

/**
 * ¿El texto (comercio, o comercio+descripción) contiene TODAS las palabras
 * dadas, en cualquier orden/posición, no necesariamente contiguas? Los
 * datos bancarios reales suelen traer nombres con iniciales de segundo
 * nombre en medio (ej. "Ingrid F Chavez D"), así que buscar la frase
 * completa como un solo substring contiguo fallaba si el usuario no
 * escribía esa inicial (ej. "Ingrid Chavez"). Se usa tanto para la consulta
 * por comercio (findConfirmedByMerchant) como para la identificación de
 * transacciones por detalles (findTransactionsByDetails), para no dejar el
 * mismo bug corregido en un lugar y vivo en el otro.
 */
function textContainsAllWords(haystackText: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const haystack = normalizeText(haystackText);
  return words.every((word) => haystack.includes(word));
}

/**
 * "hoy"/"ayer"/"anteayer" -> rango [inicio, fin) que cubre TODOS los días
 * mencionados (ej. "hoy y ayer" -> desde el inicio de ayer hasta el fin de hoy).
 */
function extractDateRange(normalizedText: string): { start: Date; end: Date } | undefined {
  const now = new Date();
  const offsets: number[] = [];
  if (/\bhoy\b/.test(normalizedText)) offsets.push(0);
  if (/\bayer\b/.test(normalizedText)) offsets.push(1);
  if (/\banteayer\b/.test(normalizedText)) offsets.push(2);
  if (offsets.length === 0) return undefined;

  const maxOffset = Math.max(...offsets);
  const minOffset = Math.min(...offsets);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxOffset);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - minOffset + 1);
  return { start, end };
}

/** "S/4.00", "PEN 4.50", "4 soles" -> 4 / 4.5. Como último recurso, un número suelto. */
function extractAmount(normalizedText: string): number | undefined {
  const currencyPrefixed = normalizedText.match(/(?:s\/\.?|pen)\s*(\d+(?:[.,]\d{1,2})?)/);
  if (currencyPrefixed) return parseFloat(currencyPrefixed[1].replace(",", "."));

  const currencySuffixed = normalizedText.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:soles|sol)\b/);
  if (currencySuffixed) return parseFloat(currencySuffixed[1].replace(",", "."));

  const bareNumber = normalizedText.match(/\b(\d+(?:[.,]\d{1,2})?)\b/);
  if (bareNumber) return parseFloat(bareNumber[1].replace(",", "."));

  return undefined;
}

interface DetailQuery {
  amount?: number;
  dateRange?: { start: Date; end: Date };
  nameCandidates: string[];
}

function extractDetailQuery(normalizedText: string): DetailQuery {
  return {
    amount: extractAmount(normalizedText),
    dateRange: extractDateRange(normalizedText),
    nameCandidates: extractNameCandidates(normalizedText),
  };
}

/** Mencionar monto o fecha es una señal específica; mencionar solo un nombre no lo es tanto. */
function hasStrongDetailSignal(query: DetailQuery): boolean {
  return query.amount !== undefined || query.dateRange !== undefined;
}

function detectRejectIntent(normalizedText: string): boolean {
  return REJECT_INTENT_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

function detectDeleteConfirmedIntent(normalizedText: string): boolean {
  return DELETE_CONFIRMED_INTENT_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

// Verbos que piden RECATEGORIZAR un gasto ya CONFIRMED, identificado por
// detalles (ej. "cambia el gasto de Oscar Saavedra a Yape/Plin") — no es
// destructivo (no pierde datos), así que un match único se aplica directo,
// sin pedir confirmación extra como sí hace eliminar.
const RECATEGORIZE_INTENT_VERBS = [
  "cambia", "cambiar", "mueve", "muevelo", "mover", "corrige", "corrigelo", "corregir",
  "recategoriza", "recategorizalo", "recategorizar", "reclasifica", "reclasificalo", "reclasificar",
];
function detectRecategorizeIntent(normalizedText: string): boolean {
  return RECATEGORIZE_INTENT_VERBS.some((verb) => normalizedText.includes(verb));
}

// Frases para revertir un REJECTED de vuelta a CONFIRMED (swipe-reply a una
// notificación vieja diciendo que, después de todo, sí se debe anotar).
const REVERT_TO_CONFIRMED_PHRASES = [
  "anotalo", "anotar", "registralo", "registrar", "si anotalo", "en realidad si",
  "vuelve a anotar", "anotalo de nuevo", "confirmalo", "si registralo",
  "considera", "considerar", "vuelve a considerar",
];

function detectConfirmIntent(normalizedText: string): boolean {
  return detectConfirmWordIntent(normalizedText) || REVERT_TO_CONFIRMED_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

// Frases que piden ver TODAS las PENDING_CONFIRMATION del usuario, sin
// filtro de comercio ni de fecha — distinto del resumen normal (que es
// sobre lo ya CONFIRMED en un período) y de la consulta por comercio (que
// sí filtra por comercio). Se detecta ANTES que el resumen normal porque
// "resumen de pendientes" también contiene "resumen de", una de las
// SUMMARY_INTENT_PHRASES de abajo — si no se chequeara primero, el resumen
// normal se la comería.
const PENDING_SUMMARY_INTENT_PHRASES = [
  "pendientes de confirmar", "pendiente de confirmar", "pendientes por confirmar",
  "que tengo pendiente", "que tengo pendientes", "cuantos pendientes", "cuantas pendientes",
  "gastos que no he confirmado", "gastos sin confirmar", "movimientos sin confirmar",
  "resumen de pendientes", "que falta confirmar", "que me falta confirmar", "movimientos pendientes",
];

function detectPendingSummaryIntent(normalizedText: string): boolean {
  return PENDING_SUMMARY_INTENT_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

// Frases que, dentro de un pedido de resumen, indican que es sobre INGRESOS
// en vez de gastos (ver detectSummaryType) — se definen antes que
// SUMMARY_INTENT_PHRASES porque también se suman ahí, para que
// detectSummaryIntent las reconozca como intención de resumen.
const INCOME_SUMMARY_PHRASES = [
  "ingresos de", "cuanto ingrese", "cuanto he ingresado", "cuanto recibi",
  "cuanto me deposito", "cuanto me depositaron", "total de ingresos", "total ingresado",
];

/** ¿El resumen pedido es sobre ingresos, o (por defecto, igual que antes) sobre gastos? */
function detectSummaryType(normalizedText: string): "EXPENSE" | "INCOME" {
  return INCOME_SUMMARY_PHRASES.some((phrase) => normalizedText.includes(phrase)) ? "INCOME" : "EXPENSE";
}

// Frases que piden un resumen/consulta de gastos (o ingresos, ver arriba),
// en vez de confirmar o rechazar un movimiento puntual — es una intención
// completamente distinta, se detecta antes que todo lo demás.
const SUMMARY_INTENT_PHRASES = [
  "resumen", "cuanto gaste", "cuanto he gastado", "cuanto llevo", "cuanto gasto",
  "cuanto va", "como voy", "gastos de", "resumen de", "total gastado", "cuanto se gasto",
  "desglose",
  ...INCOME_SUMMARY_PHRASES,
];

function detectSummaryIntent(normalizedText: string): boolean {
  return SUMMARY_INTENT_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

// Comando manual para pedir el reporte semanal (imagen) sin esperar al cron
// del domingo 8pm — se chequea antes que el resumen general (ver más abajo
// en handleIncomingMessage) porque comparte la palabra "resumen".
// Deliberadamente NO incluye "resumen de la semana"/"resumen de esta
// semana" — esas ya significan algo distinto y ya funcionan bien: el
// resumen de TEXTO existente (buildSummaryReply) para el rango "esta
// semana" (extractSummaryDateRange ya reconoce "semana" como palabra
// suelta). Solo "semanal" como adjetivo pegado a "resumen"/"reporte" pide
// específicamente la imagen nueva.
const WEEKLY_REPORT_INTENT_PHRASES = ["resumen semanal", "reporte semanal"];
function detectWeeklyReportIntent(normalizedText: string): boolean {
  return WEEKLY_REPORT_INTENT_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

/** "resumen de hoy por hora", "desglose por hora", "hora por hora" -> pedir el detalle cronológico en vez del desglose por categoría. */
function wantsHourlyBreakdown(normalizedText: string): boolean {
  return /\bpor hora\b/.test(normalizedText) || /\bhora por hora\b/.test(normalizedText);
}

/**
 * Igual que extractDateRange, pero además entiende "esta semana"/"este mes"/
 * "últimos N días" (rangos reales, no un solo día) y, si no reconoce
 * ninguna referencia de fecha, cae a "hoy" por defecto — a diferencia de
 * extractDateRange, que para identificar una transacción puntual prefiere
 * no asumir nada. `isMultiDay` decide si el resumen usa el formato
 * agrupado por día o el simple de una sola línea por categoría.
 */
function extractSummaryDateRange(
  normalizedText: string
): { start: Date; end: Date; label: string; isMultiDay: boolean } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/\bsemana\b/.test(normalizedText)) {
    const diffToMonday = (now.getDay() + 6) % 7; // días transcurridos desde el lunes
    const start = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - diffToMonday);
    const end = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1);
    return { start, end, label: "esta semana", isMultiDay: true };
  }

  if (/\bmes\b/.test(normalizedText)) {
    const start = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const end = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1);
    return { start, end, label: "este mes", isMultiDay: true };
  }

  const lastNDaysMatch = normalizedText.match(/ultimos?\s+(\d+)\s+dias?/);
  if (lastNDaysMatch) {
    const n = Math.max(1, parseInt(lastNDaysMatch[1], 10));
    const start = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - (n - 1));
    const end = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1);
    return { start, end, label: `últimos ${n} días`, isMultiDay: n > 1 };
  }

  const dayLabels: string[] = [];
  if (/\bhoy\b/.test(normalizedText)) dayLabels.push("hoy");
  if (/\bayer\b/.test(normalizedText)) dayLabels.push("ayer");
  if (/\banteayer\b/.test(normalizedText)) dayLabels.push("anteayer");

  const dayRange = extractDateRange(normalizedText);
  if (dayRange) {
    return { ...dayRange, label: dayLabels.join(" y "), isMultiDay: dayLabels.length > 1 };
  }

  return {
    start: todayStart,
    end: new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1),
    label: "hoy",
    isMultiDay: false,
  };
}

/**
 * Arma el resumen de movimientos CONFIRMED de un usuario para el rango de
 * fechas que se detecte en el mensaje (por defecto, hoy) — de gastos, o de
 * ingresos si el mensaje lo pide explícitamente (ver detectSummaryType).
 * Para un solo día usa el desglose simple por categoría; para 2+ días, el
 * formato agrupado por día (con total del período, el más grande, y
 * desglose por categoría al cierre) — salvo que se haya pedido
 * explícitamente el detalle por hora.
 */
async function buildSummaryReply(userId: string, normalizedText: string, userName: string): Promise<string> {
  const { start, end, label, isMultiDay } = extractSummaryDateRange(normalizedText);
  const summaryType = detectSummaryType(normalizedText);
  const typeLabel = summaryType === "INCOME" ? "ingresos" : "gastos";

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      status: "CONFIRMED",
      deletedAt: null,
      type: summaryType,
      occurredAt: { gte: start, lt: end },
    },
    include: { category: true },
  });

  if (transactions.length === 0) {
    return `No tienes ${typeLabel} confirmados registrados para ${label}.`;
  }

  if (wantsHourlyBreakdown(normalizedText)) {
    return buildHourlySummaryReply(transactions, label);
  }

  if (isMultiDay) {
    return buildDailyGroupedSummaryReply(transactions, label, userName);
  }

  const totalsByCurrency = new Map<string, number>();
  for (const t of transactions) {
    totalsByCurrency.set(t.currency, (totalsByCurrency.get(t.currency) ?? 0) + Number(t.amount));
  }
  const showPercentages = totalsByCurrency.size === 1;
  const grandTotal = showPercentages ? [...totalsByCurrency.values()][0] : 0;

  const byCategory = new Map<string, { name: string; icon: string; currency: string; amount: number; count: number }>();
  for (const t of transactions) {
    const key = `${t.categoryId ?? "sin-categoria"}|${t.currency}`;
    const name = t.category?.name ?? "Sin categoría";
    const icon = t.category ? CATEGORY_ICON_BY_NAME.get(t.category.name) ?? FALLBACK_CATEGORY_ICON : "❔";
    const entry = byCategory.get(key) ?? { name, icon, currency: t.currency, amount: 0, count: 0 };
    entry.amount += Number(t.amount);
    entry.count += 1;
    byCategory.set(key, entry);
  }
  const sorted = [...byCategory.values()].sort((a, b) => b.amount - a.amount);

  const totalLine = [...totalsByCurrency.entries()].map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(" + ");

  const lines = [
    `📊 *Resumen — ${label}*`,
    "",
    `💰 *Total:* ${totalLine} (${transactions.length} movimiento${transactions.length === 1 ? "" : "s"})`,
    "",
  ];

  sorted.forEach((c) => {
    const detail = showPercentages
      ? `${Math.round((c.amount / grandTotal) * 100)}%`
      : `${c.count} mov.`;
    lines.push(`${c.icon} ${c.name}: ${c.currency} ${c.amount.toFixed(2)} (${detail})`);
  });

  return lines.join("\n");
}

/**
 * Variante cronológica del resumen ("resumen de hoy por hora"): un
 * movimiento por línea con su hora, en vez de agrupar por categoría.
 * Usa occurredAt (no createdAt) porque es el campo que trae la hora real
 * del movimiento cuando el correo la traía — createdAt es solo cuándo
 * nuestro proceso lo sincronizó, que puede ser horas o días después.
 */
function buildHourlySummaryReply(transactions: PendingTransaction[], label: string): string {
  const sorted = [...transactions].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const totalsByCurrency = new Map<string, number>();
  for (const t of transactions) {
    totalsByCurrency.set(t.currency, (totalsByCurrency.get(t.currency) ?? 0) + Number(t.amount));
  }
  const totalLine = [...totalsByCurrency.entries()].map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(" + ");

  const lines = [`📊 *Resumen — ${label}* (por hora)`, ""];
  sorted.forEach((t) => {
    const hh = String(t.occurredAt.getHours()).padStart(2, "0");
    const mm = String(t.occurredAt.getMinutes()).padStart(2, "0");
    const who = t.merchant || t.description || "Movimiento";
    lines.push(`🕐 ${hh}:${mm} · ${who} · ${formatAmount(t)}`);
  });
  lines.push("", `💰 *Total:* ${totalLine} (${transactions.length} movimiento${transactions.length === 1 ? "" : "s"})`);

  return lines.join("\n");
}

/**
 * Resumen agrupado por día (más reciente primero) para rangos de 2+ días.
 * Dentro de cada día, los movimientos van en orden cronológico con hora,
 * monto, comercio y el emoji de su categoría (sin texto de categoría entre
 * paréntesis, para que sea más escaneable en una pantalla de celular).
 * Cierra con el total del período, el gasto más grande, el desglose por
 * categoría, y una nota si algún gasto se confirmó días después de ocurrir.
 */
function buildDailyGroupedSummaryReply(transactions: PendingTransaction[], label: string, userName: string): string {
  const dayMap = new Map<number, { dayStart: Date; items: PendingTransaction[] }>();
  for (const t of transactions) {
    const d = t.occurredAt;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const key = dayStart.getTime();
    const entry = dayMap.get(key) ?? { dayStart, items: [] };
    entry.items.push(t);
    dayMap.set(key, entry);
  }
  const days = [...dayMap.values()].sort((a, b) => b.dayStart.getTime() - a.dayStart.getTime());

  const lines: string[] = [`📒 Aquí tienes tu resumen, ${userName}`, ""];

  days.forEach((day) => {
    const dayItems = [...day.items].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const dayName = capitalize(DAY_NAMES_ES[day.dayStart.getDay()]);
    const dayTotal = formatTotalsByCurrency(dayItems.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));

    lines.push(`*${dayName} ${formatShortDate(day.dayStart)}* — ${dayItems.length} mov. · ${dayTotal}`);
    dayItems.forEach((t) => {
      const hh = String(t.occurredAt.getHours()).padStart(2, "0");
      const mm = String(t.occurredAt.getMinutes()).padStart(2, "0");
      const who = t.merchant || t.description || "Movimiento";
      const icon = t.category ? CATEGORY_ICON_BY_NAME.get(t.category.name) ?? FALLBACK_CATEGORY_ICON : "❔";
      lines.push(`  ${hh}:${mm} · ${formatAmount(t)} · ${who} ${icon}`);
    });
    lines.push("");
  });

  const grandTotalLine = formatTotalsByCurrency(transactions.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));
  const biggest = [...transactions].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
  const biggestWho = biggest.merchant || biggest.description || "el movimiento";

  lines.push(`💰 *Total del período:* ${grandTotalLine} (${transactions.length} movimiento${transactions.length === 1 ? "" : "s"})`);
  lines.push(`💸 *El más grande:* ${formatAmount(biggest)} en ${biggestWho}`);

  const byCategory = new Map<string, { name: string; icon: string; currency: string; amount: number }>();
  for (const t of transactions) {
    const key = `${t.categoryId ?? "sin-categoria"}|${t.currency}`;
    const name = t.category?.name ?? "Sin categoría";
    const icon = t.category ? CATEGORY_ICON_BY_NAME.get(t.category.name) ?? FALLBACK_CATEGORY_ICON : "❔";
    const entry = byCategory.get(key) ?? { name, icon, currency: t.currency, amount: 0 };
    entry.amount += Number(t.amount);
    byCategory.set(key, entry);
  }
  const sortedCategories = [...byCategory.values()].sort((a, b) => b.amount - a.amount);
  lines.push("", "*Por categoría:*");
  sortedCategories.forEach((c) => {
    lines.push(`${c.icon} ${c.name}: ${c.currency} ${c.amount.toFixed(2)}`);
  });

  const lateConfirmed = transactions.filter((t) => t.confirmedAt && !sameCalendarDay(t.confirmedAt, t.occurredAt));
  if (lateConfirmed.length > 0) {
    const n = lateConfirmed.length;
    lines.push(
      "",
      `_Nota: ${n} movimiento${n === 1 ? "" : "s"} se confirm${n === 1 ? "ó" : "aron"} varios días después de haber ocurrido._`
    );
  }

  return lines.join("\n");
}

/**
 * Busca, entre TODAS las transacciones de un usuario con el `status` dado
 * (sin límite de fecha), las que coinciden con las pistas extraídas del
 * mensaje. El monto es el filtro más confiable (tolerancia ±0.01); el
 * nombre y la fecha son filtros adicionales, todos combinados con AND.
 * Si no se extrajo ninguna pista útil (ni monto ni nombre), no busca nada.
 * `status` es parametrizable para reusar la misma búsqueda tanto para
 * identificar un PENDING_CONFIRMATION (confirmar/rechazar) como para
 * encontrar un CONFIRMED que el usuario quiere eliminar. Por defecto
 * excluye los eliminados (deletedAt no nulo); `onlyDeleted` invierte
 * eso para buscar específicamente entre los ya eliminados (restaurar).
 */
async function findTransactionsByDetails(
  userId: string,
  query: DetailQuery,
  status: "PENDING_CONFIRMATION" | "CONFIRMED",
  options: { onlyDeleted?: boolean } = {}
): Promise<PendingTransaction[]> {
  if (query.amount === undefined && query.nameCandidates.length === 0) return [];

  const candidates = await prisma.transaction.findMany({
    where: {
      userId,
      status,
      deletedAt: options.onlyDeleted ? { not: null } : null,
      ...(query.dateRange ? { occurredAt: { gte: query.dateRange.start, lt: query.dateRange.end } } : {}),
    },
    include: { category: true },
  });

  return candidates.filter((t) => {
    if (query.amount !== undefined && Math.abs(Number(t.amount) - query.amount) > 0.01) {
      return false;
    }
    if (query.nameCandidates.length > 0) {
      const haystack = `${t.merchant ?? ""} ${t.description ?? ""}`;
      if (!textContainsAllWords(haystack, query.nameCandidates)) return false;
    }
    return true;
  });
}

function buildDisambiguationMessage(candidates: PendingTransaction[]): string {
  const lines = ["Encontré más de un movimiento que podría ser ese. ¿Cuál es? Responde con el número:", ""];
  candidates.forEach((t, i) => {
    const who = t.merchant || t.description || "Movimiento";
    lines.push(`${i + 1}. ${who} — ${formatAmount(t)} (${formatShortDate(t.occurredAt)})`);
  });
  return lines.join("\n");
}

function buildConfirmPrompt(t: PendingTransaction): string {
  const who = t.merchant || t.description || "el movimiento";
  return `Encontré esta transacción: ${formatAmount(t)} en ${who} (${formatShortDate(t.occurredAt)}). ¿La confirmamos? Responde *Sí* o *No*.`;
}

/** Eliminar un movimiento ya CONFIRMED es irreversible: siempre se pide esta confirmación explícita antes de borrar. */
function buildDeleteConfirmPrompt(t: PendingTransaction): string {
  const who = t.merchant || t.description || "el movimiento";
  const kind = t.type === "INCOME" ? "ingreso" : "gasto";
  return (
    `⚠️ ¿Confirmas que quieres *eliminar* este ${kind} ya registrado? ` +
    `${formatAmount(t)} en ${who} (${formatShortDate(t.occurredAt)}). Responde *Sí* para eliminarlo.`
  );
}

/** Swipe-reply a la notificación de un gasto que ya está CONFIRMED, sin intención clara en el texto. */
function buildAlreadyConfirmedPrompt(t: PendingTransaction): string {
  const who = t.merchant || t.description || "el movimiento";
  return (
    `Este movimiento ya está *confirmado*: ${formatAmount(t)} en ${who} (${formatShortDate(t.occurredAt)}). ` +
    `¿Quieres eliminarlo? Responde *Sí* para eliminarlo.`
  );
}

/** Swipe-reply a la notificación de un gasto que fue REJECTED, sin intención clara en el texto. */
function buildAlreadyRejectedPrompt(t: PendingTransaction): string {
  const who = t.merchant || t.description || "el movimiento";
  return (
    `Este movimiento fue *descartado* anteriormente: ${formatAmount(t)} en ${who} (${formatShortDate(t.occurredAt)}). ` +
    `¿Quieres anotarlo ahora? Responde *Sí* para registrarlo.`
  );
}

/** Swipe-reply (o identificación por detalles) a un gasto CONFIRMED que ya está eliminado (soft-delete), sin intención clara. */
function buildRestorePrompt(t: PendingTransaction): string {
  const who = t.merchant || t.description || "el movimiento";
  return (
    `Este movimiento fue *eliminado* anteriormente: ${formatAmount(t)} en ${who} (${formatShortDate(t.occurredAt)}). ` +
    `¿Quieres restaurarlo? Responde *Sí* para restaurarlo.`
  );
}

interface ResolvedIntent {
  action: "confirm" | "reject" | "delete" | "restore" | "recategorize";
  category?: { id: string; name: string };
}

/**
 * Estado de "esperando una respuesta puntual del usuario para una
 * transacción ya identificada", en memoria por proceso: puede ser una
 * desambiguación real (varias transacciones candidatas, se espera un
 * número) o una confirmación explícita pendiente (una sola transacción,
 * se espera sí/no porque el mensaje original no dejó clara la intención).
 * `intent` es la acción ya decidida por el mensaje que generó el estado
 * (null si todavía no se sabe qué hacer). Diseño: es una interacción de
 * segundos, no hace falta persistirla en la DB — si el proceso se reinicia
 * justo en el medio, el usuario simplemente vuelve a intentar.
 */
interface DisambiguationState {
  transactionIds: string[];
  intent: ResolvedIntent | null;
  createdAt: number;
}
const DISAMBIGUATION_TTL_MS = 10 * 60 * 1000;
const disambiguationByUserId = new Map<string, DisambiguationState>();

/**
 * Datos ya extraídos de una captura de transferencia (Fase 4), esperando
 * que el usuario diga si es GASTO/TRASPASO/INGRESO — se pregunta siempre
 * con botones porque una captura de transferencia es ambigua por
 * naturaleza (puede ser a un tercero o entre cuentas propias). Mismo
 * mecanismo de Map en memoria + TTL que disambiguationByUserId, en un Map
 * aparte porque la forma de los datos no tiene nada que ver.
 */
interface PendingImageClassification {
  amount: number;
  currency: string;
  recipient?: string;
  bankOrWallet?: string;
  fee?: number;
  occurredAt: Date;
  operationNumber?: string;
  suggestedCategory?: string;
  createdAt: number;
}
const PENDING_IMAGE_TTL_MS = 10 * 60 * 1000;
const pendingImageByUserId = new Map<string, PendingImageClassification>();

/**
 * Contexto de una conversación de seguimiento que NO es una desambiguación
 * de transacción puntual (ver disambiguationByUserId arriba): una consulta
 * de gastos por comercio que puede seguir con "muéstralos todos" o "¿en qué
 * categoría están?", o la pregunta de si aplicar una regla nueva también a
 * movimientos ya existentes. Mismo mecanismo (Map en memoria por proceso,
 * TTL, se consume siempre al leer) que la desambiguación, pero con otra
 * forma de datos — por eso va en un Map separado en vez de forzarlo dentro
 * de DisambiguationState.
 */
interface MerchantQueryFollowUp {
  type: "merchant_query";
  merchant: string;
  transactionIds: string[]; // TODOS los que coinciden, orden desc por fecha
  shownCount: number; // cuántos ya se mostraron en el mensaje inicial
}
interface RetroactiveRuleFollowUp {
  type: "retroactive_rule";
  categoryId: string;
  categoryName: string;
  transactionIds: string[]; // transacciones existentes que coinciden con el criterio de la regla
}
interface PendingReviewFollowUp {
  type: "pending_review";
  transactionIds: string[]; // TODAS las PENDING_CONFIRMATION al momento de la consulta, orden desc por fecha
}
interface CategoryQueryFollowUp {
  type: "category_query";
  categoryName: string;
  transactionIds: string[]; // TODOS los CONFIRMED de esa categoría en el período consultado, orden desc por fecha
}
type FollowUpContext = MerchantQueryFollowUp | RetroactiveRuleFollowUp | PendingReviewFollowUp | CategoryQueryFollowUp;
interface FollowUpState {
  context: FollowUpContext;
  createdAt: number;
}
const FOLLOWUP_TTL_MS = 10 * 60 * 1000;
const followUpByUserId = new Map<string, FollowUpState>();

/**
 * El número que manda Meta en `message.from` viene sin "+" (ej. "51987654321"),
 * pero guardamos phoneNumber en formato E.164 ("+51987654321"). Probamos ambas
 * formas para no depender de cuál se haya usado al registrar al usuario.
 */
function findUserByWhatsappNumber(from: string) {
  const withPlus = from.startsWith("+") ? from : `+${from}`;
  const withoutPlus = from.startsWith("+") ? from.slice(1) : from;
  return prisma.user.findFirst({
    where: { OR: [{ phoneNumber: withPlus }, { phoneNumber: withoutPlus }] },
  });
}

/**
 * Busca, dentro del texto ya normalizado, algún alias que coincida con una
 * de las categorías reales del usuario (o el propio nombre de la categoría).
 * Devuelve la primera coincidencia, o null si no hay ninguna clara.
 */
function resolveCategoryFromText(
  normalizedText: string,
  categories: { id: string; name: string }[]
): { id: string; name: string } | null {
  for (const category of categories) {
    const candidates = [normalizeText(category.name), ...(CATEGORY_ALIASES[category.name] ?? [])];
    if (candidates.some((alias) => alias.length > 2 && normalizedText.includes(alias))) {
      return category;
    }
  }
  return null;
}

async function getCategories(userId: string): Promise<{ id: string; name: string }[]> {
  return prisma.category.findMany({
    where: { userId, isArchived: false },
    select: { id: true, name: true },
  });
}

// Frases que indican que el usuario quiere crear una regla de
// categorización automática, no confirmar/rechazar/consultar algo puntual.
const CREATE_RULE_TRIGGER_PHRASES = [
  "siempre que", "cada vez que", "todo gasto", "todos los gastos", "todo movimiento",
  "cuando gaste en", "cuando el gasto sea", "gastos mayores", "gastos menores", "gastos iguales",
  "de ahora en adelante",
];

function detectCreateRuleIntent(normalizedText: string): boolean {
  return CREATE_RULE_TRIGGER_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

/** "...gasto hacia/en/a/de STARBUCKS, colócalo..." -> "starbucks". */
function extractMerchantRuleCriterion(normalizedText: string): string | null {
  const match = normalizedText.match(
    /(?:gasto|gastos|movimiento|movimientos)s?\s+(?:hacia|en|a|de)\s+([a-z0-9ñ\s]+?)(?:\s*,|\s+(?:coloc\w*|pon\w*|categoriz\w*|mand\w*|marc\w*|v[ae]n?\b))/
  );
  const text = match?.[1]?.trim();
  return text && text.length > 1 ? text : null;
}

interface AmountRuleCriterion {
  type: "AMOUNT_GREATER_THAN" | "AMOUNT_LESS_THAN" | "AMOUNT_EQUALS";
  amount: number;
  label: string;
}

/** "gastos mayores/menores/iguales a S/N" -> operador + monto. */
function extractAmountRuleCriterion(normalizedText: string): AmountRuleCriterion | null {
  const numberPattern = `(?:s\\/\\.?|pen)?\\s*(\\d+(?:[.,]\\d{1,2})?)`;
  const gt = normalizedText.match(new RegExp(`mayor(?:es)?\\s+(?:o\\s+igual\\s+)?a\\s+${numberPattern}`));
  if (gt) return { type: "AMOUNT_GREATER_THAN", amount: parseFloat(gt[1].replace(",", ".")), label: "mayor a" };

  const lt = normalizedText.match(new RegExp(`menor(?:es)?\\s+(?:o\\s+igual\\s+)?a\\s+${numberPattern}`));
  if (lt) return { type: "AMOUNT_LESS_THAN", amount: parseFloat(lt[1].replace(",", ".")), label: "menor a" };

  const eq = normalizedText.match(new RegExp(`igual(?:es)?\\s+a\\s+${numberPattern}`));
  if (eq) return { type: "AMOUNT_EQUALS", amount: parseFloat(eq[1].replace(",", ".")), label: "igual a" };

  return null;
}

// Frases conectoras que en un mensaje de CREACIÓN DE REGLA introducen la
// categoría de DESTINO explícita, ej. "...va a Alimentación", "...colócalo
// en Transporte". Solo se usan para ese flujo puntual (ver más abajo en
// handleIncomingMessage): buscar el alias de categoría nada más en el texto
// que viene después de una de estas frases evita que un alias que aparezca
// antes, como parte del CRITERIO de la regla (ej. "taxi" en "todo gasto en
// Taxi va a Movimientos financieros"), se cuele como si fuera el destino.
// El resto de flujos (confirmar/corregir categoría de una transacción)
// siguen usando resolveCategoryFromText sobre el mensaje completo — ahí no
// hay un "criterio" separado del "destino" que puedan confundirse.
const RULE_TARGET_CATEGORY_CONNECTORS = [
  "en la categoria de", "en la categoria", "categorizalo como", "categorizado como",
  "clasificalo como", "van a", "vayan a", "va a", "vaya a", "coloca en", "colocalo en",
  "ponlo en", "pon en", "manda a", "mandalo a", "marca como", "marcalo como",
];

/**
 * Recorta el texto al fragmento que viene después de la ÚLTIMA frase
 * conectora encontrada (la más cercana al final, por si el criterio de la
 * regla también contiene alguna de estas palabras). Si no aparece ninguna,
 * devuelve el texto completo sin recortar — comportamiento actual, usado
 * como fallback.
 */
function extractRuleTargetCategoryText(normalizedText: string): string {
  let bestStart = -1;
  let bestEnd = -1;
  for (const connector of RULE_TARGET_CATEGORY_CONNECTORS) {
    const idx = normalizedText.lastIndexOf(connector);
    if (idx > bestStart) {
      bestStart = idx;
      bestEnd = idx + connector.length;
    }
  }
  return bestStart === -1 ? normalizedText : normalizedText.slice(bestEnd).trim();
}

/**
 * Resuelve la categoría de DESTINO de una regla nueva: primero busca el
 * alias solo en el fragmento después del conector ("va a X", "colócalo en
 * X"...); si eso no encuentra nada (o no hay conector), cae a buscar en el
 * mensaje completo, igual que antes.
 */
function resolveRuleTargetCategory(
  normalizedText: string,
  categories: { id: string; name: string }[]
): { id: string; name: string } | null {
  const targetText = extractRuleTargetCategoryText(normalizedText);
  return resolveCategoryFromText(targetText, categories) ?? resolveCategoryFromText(normalizedText, categories);
}

/**
 * Recorta un comando de recategorización ("cambia el gasto de X a Y") al
 * fragmento ANTES de la categoría de destino, para buscar la transacción
 * (por monto/nombre) sin que la categoría se cuele como si fuera parte del
 * nombre buscado. Mismo vocabulario de conectores que resolveRuleTargetCategory,
 * más la preposición "a" sola (muy común en este comando puntual: "cambia
 * X a Y"), con límites de palabra (\b) para no cortar dentro de otra palabra.
 */
function extractRecategorizeIdentificationText(normalizedText: string): string {
  const connectors = [...RULE_TARGET_CATEGORY_CONNECTORS, "a"];
  let bestStart = -1;
  for (const connector of connectors) {
    const regex = new RegExp(`\\b${connector}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(normalizedText)) !== null) {
      if (match.index > bestStart) bestStart = match.index;
    }
  }
  return bestStart === -1 ? normalizedText : normalizedText.slice(0, bestStart).trim();
}

// Cuántos movimientos recientes se muestran en el primer mensaje de una
// consulta por comercio, antes de ofrecer verlos todos.
const MERCHANT_QUERY_PAGE_SIZE = 10;

/**
 * "detalle de gastos hacia/en/a/con X", "gastos hacia/en/a/con X",
 * "cuánto le he pagado a X", "cuánto le pagué a X" -> "X" (recortado de
 * coletillas de cortesía y signos de puntuación al final). Nace como una
 * intención de solo lectura distinta al resumen general (SUMMARY_INTENT_PHRASES),
 * que no apunta a un comercio específico — por eso se detecta con patrones
 * propios en vez de sumarse a esa lista.
 */
interface DateRangeMatch {
  start: Date;
  end: Date;
  label: string;
}

/** Rango "este mes" (día 1 hasta hoy incluido) — es el período por defecto de la consulta por categoría. */
function monthToDateRange(): DateRangeMatch {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start, end, label: "este mes" };
}

/**
 * Rangos de fecha que se pueden mencionar dentro de una consulta por
 * comercio o por categoría (ej. "gastos hacia X en lo que va del mes").
 * Mismo vocabulario que extractSummaryDateRange, pero acá cada patrón
 * guarda también el texto que matcheó, para poder recortarlo del mensaje
 * ANTES de extraer el nombre del comercio/categoría — si no se recorta, la
 * frase de fecha se cuela como si fuera parte de lo buscado (bug real
 * detectado: "olga huaman en lo que va del mes" no coincide con ningún
 * merchant real, así que la búsqueda no encontraba nada aunque sí
 * existieran movimientos).
 */
const MERCHANT_QUERY_DATE_PATTERNS: { regex: RegExp; toRange: (match: RegExpMatchArray) => DateRangeMatch }[] = [
  {
    regex: /en lo que va del mes|en lo que va de mes|este mes/,
    toRange: () => monthToDateRange(),
  },
  {
    regex: /en lo que va de la semana|en lo que va de semana|esta semana/,
    toRange: () => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diffToMonday = (now.getDay() + 6) % 7;
      const start = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - diffToMonday);
      const end = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1);
      return { start, end, label: "esta semana" };
    },
  },
  {
    regex: /ultimos?\s+(\d+)\s+dias?/,
    toRange: (match) => {
      const n = Math.max(1, parseInt(match[1], 10));
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const start = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - (n - 1));
      const end = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1);
      return { start, end, label: `últimos ${n} días` };
    },
  },
  {
    regex: /\bhoy\b/,
    toRange: () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { start, end: new Date(start.getTime() + 86_400_000), label: "hoy" };
    },
  },
  {
    regex: /\bayer\b/,
    toRange: () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { start, end: new Date(start.getTime() + 86_400_000), label: "ayer" };
    },
  },
  {
    regex: /\banteayer\b/,
    toRange: () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
      return { start, end: new Date(start.getTime() + 86_400_000), label: "anteayer" };
    },
  },
];

/** Busca un rango de fecha mencionado en el texto; devuelve también el texto exacto que matcheó, para recortarlo. */
function extractMerchantQueryDateRange(normalizedText: string): { range: DateRangeMatch; matchedText: string } | undefined {
  for (const { regex, toRange } of MERCHANT_QUERY_DATE_PATTERNS) {
    const match = normalizedText.match(regex);
    if (match) return { range: toRange(match), matchedText: match[0] };
  }
  return undefined;
}

/**
 * "detalle de gastos hacia/en/a/con X", "gastos hacia/en/a/con X",
 * "cuánto le he pagado a X", "cuánto le pagué a X" -> comercio (recortado
 * de coletillas de cortesía, signos de puntuación, y cualquier rango de
 * fecha mencionado, que se devuelve aparte en `dateRange`). Nace como una
 * intención de solo lectura distinta al resumen general (SUMMARY_INTENT_PHRASES),
 * que no apunta a un comercio específico — por eso se detecta con patrones
 * propios en vez de sumarse a esa lista.
 */
function extractMerchantQuery(normalizedText: string): { merchant: string; dateRange?: DateRangeMatch } | null {
  const dateMatch = extractMerchantQueryDateRange(normalizedText);
  // Se quita la frase de fecha ANTES de buscar el comercio, para que no quede pegada al final del fragmento capturado.
  const textForMerchant = dateMatch ? normalizedText.replace(dateMatch.matchedText, " ") : normalizedText;

  const patterns = [
    /(?:detalle de )?gastos?\s+(?:hacia|en|con|a)\s+(.+)/,
    /cuanto\s+(?:le\s+)?(?:he\s+)?pagad[oa]\s+a\s+(.+)/,
    /cuanto\s+le\s+pague\s+a\s+(.+)/,
  ];
  for (const pattern of patterns) {
    const match = textForMerchant.match(pattern);
    if (!match) continue;
    const cleaned = match[1]
      .replace(/\b(por favor|porfavor|please)\b/g, "")
      .replace(/[?.!,]+$/g, "")
      .trim();
    if (cleaned.length > 1) return { merchant: cleaned, dateRange: dateMatch?.range };
  }
  return null;
}

type ConfirmedTxWithCategory = PendingTransaction;

/**
 * "detalle de X", "gastos en X", "cuánto gasté en X", "resumen de X" -> la
 * categoría real que resuelva X (recortado de fecha y coletillas), o null
 * si X no resuelve a ninguna categoría del usuario — en ese caso NO es una
 * consulta por categoría (puede ser una consulta por comercio, que se
 * evalúa aparte en handleIncomingMessage). Comparte conectores con la
 * consulta por comercio ("gastos en X"), así que se intenta ANTES: una
 * categoría real de Gastia nunca es también el nombre de un comercio real.
 */
function extractCategoryQuery(
  normalizedText: string,
  categories: { id: string; name: string }[]
): { category: { id: string; name: string }; dateRange: DateRangeMatch } | null {
  const dateMatch = extractMerchantQueryDateRange(normalizedText);
  const textForCategory = dateMatch ? normalizedText.replace(dateMatch.matchedText, " ") : normalizedText;

  const patterns = [
    /(?:detalle de )?gastos?\s+(?:hacia|en|con|a)\s+(.+)/,
    /cuanto\s+(?:he\s+)?gast[eo]\s+en\s+(.+)/,
    /resumen\s+de\s+(.+)/,
    /detalle\s+de\s+(.+)/,
  ];
  for (const pattern of patterns) {
    const match = textForCategory.match(pattern);
    if (!match) continue;
    const cleaned = match[1]
      .replace(/\b(por favor|porfavor|please)\b/g, "")
      .replace(/[?.!,]+$/g, "")
      .trim();
    if (cleaned.length <= 1) continue;
    const category = resolveCategoryFromText(cleaned, categories);
    if (category) return { category, dateRange: dateMatch?.range ?? monthToDateRange() };
  }
  return null;
}

/** Total CONFIRMED (no eliminadas) de una categoría en un rango de fecha, más recientes primero. */
async function findConfirmedByCategory(
  userId: string,
  categoryId: string,
  dateRange: DateRangeMatch
): Promise<ConfirmedTxWithCategory[]> {
  return prisma.transaction.findMany({
    where: {
      userId,
      status: "CONFIRMED",
      deletedAt: null,
      categoryId,
      occurredAt: { gte: dateRange.start, lt: dateRange.end },
    },
    include: { category: true },
    orderBy: { occurredAt: "desc" },
  });
}

/** Mensaje inicial de la consulta por categoría: solo el agregado (total y cantidad), sin listar movimientos todavía. */
function buildCategoryQueryReply(
  category: { name: string },
  transactions: ConfirmedTxWithCategory[],
  dateRange: DateRangeMatch
): string {
  const icon = CATEGORY_ICON_BY_NAME.get(category.name) ?? FALLBACK_CATEGORY_ICON;
  if (transactions.length === 0) {
    return `${icon} *${category.name} — ${dateRange.label}*\n\nNo tienes movimientos confirmados en esta categoría por ahora.`;
  }
  const totalLine = formatTotalsByCurrency(transactions.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));
  return [
    `${icon} *${category.name} — ${dateRange.label}*`,
    "",
    `Llevas ${totalLine} en ${transactions.length} movimiento${transactions.length === 1 ? "" : "s"} confirmado${transactions.length === 1 ? "" : "s"}.`,
    "",
    "¿Te detallo cada movimiento uno por uno?",
  ].join("\n");
}

/** Listado individual (hasta MERCHANT_QUERY_PAGE_SIZE) tras confirmar que sí quiere el detalle de una consulta por categoría. */
function buildCategoryItemizedReply(category: { name: string }, transactions: ConfirmedTxWithCategory[]): string {
  const icon = CATEGORY_ICON_BY_NAME.get(category.name) ?? FALLBACK_CATEGORY_ICON;
  const shown = transactions.slice(0, MERCHANT_QUERY_PAGE_SIZE);
  const lines = [`${icon} *Gastos de ${category.name}*`, ""];
  shown.forEach((t) => {
    const who = t.merchant || t.description || "Movimiento";
    lines.push(`• ${formatShortDate(t.occurredAt)} · ${formatAmount(t)} · ${who}`);
  });
  if (transactions.length > shown.length) {
    lines.push("", `...y ${transactions.length - shown.length} más.`);
  }
  return lines.join("\n");
}

/**
 * CONFIRMED y PENDING_CONFIRMATION (no eliminadas) cuyo comercio contiene el
 * fragmento, cada grupo más reciente primero, opcionalmente acotadas a un
 * rango de fecha. Las pendientes son solo para mostrarlas informativamente
 * en la consulta (ver buildMerchantQueryReply) — esta función no las
 * distingue por urgencia ni ofrece confirmarlas/rechazarlas, eso sigue
 * siendo un flujo aparte (swipe-reply, botones, o texto libre).
 */
async function findConfirmedByMerchant(
  userId: string,
  merchantFragment: string,
  dateRange?: DateRangeMatch
): Promise<{ confirmed: ConfirmedTxWithCategory[]; pending: ConfirmedTxWithCategory[] }> {
  const queryWords = toContentWords(merchantFragment);
  const candidates = await prisma.transaction.findMany({
    where: {
      userId,
      status: { in: ["CONFIRMED", "PENDING_CONFIRMATION"] },
      deletedAt: null,
      ...(dateRange ? { occurredAt: { gte: dateRange.start, lt: dateRange.end } } : {}),
    },
    include: { category: true },
    orderBy: { occurredAt: "desc" },
  });
  const matches = candidates.filter((t) => t.merchant && textContainsAllWords(t.merchant, queryWords));
  return {
    confirmed: matches.filter((t) => t.status === "CONFIRMED"),
    pending: matches.filter((t) => t.status === "PENDING_CONFIRMATION"),
  };
}

/**
 * Mensaje inicial de la consulta: cantidad y total de los CONFIRMED (el
 * total nunca mezcla con los pendientes) con los más recientes (hasta
 * MERCHANT_QUERY_PAGE_SIZE), y si hay PENDING_CONFIRMATION que coinciden,
 * una sección aparte claramente marcada, solo informativa (sin oferta de
 * confirmar/rechazar desde acá). La paginación ("¿quieres ver el resto?")
 * sigue aplicando solo a los confirmados.
 */
function buildMerchantQueryReply(
  merchantFragment: string,
  confirmed: ConfirmedTxWithCategory[],
  pending: ConfirmedTxWithCategory[],
  dateRange?: DateRangeMatch
): { reply: string; displayMerchant: string; shownCount: number } {
  const displayMerchant = (confirmed[0] ?? pending[0])?.merchant || capitalize(merchantFragment);
  const shown = confirmed.slice(0, MERCHANT_QUERY_PAGE_SIZE);
  const totalLine = formatTotalsByCurrency(confirmed.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));
  const periodSuffix = dateRange ? ` — ${dateRange.label}` : "";

  const lines = [`🔎 *Gastos hacia ${displayMerchant}${periodSuffix}*`, ""];

  if (confirmed.length > 0) {
    lines.push(
      `${confirmed.length} confirmado${confirmed.length === 1 ? "" : "s"} · Total: ${totalLine}`,
      ""
    );
    shown.forEach((t) => {
      const detail = t.description ? ` — ${t.description}` : "";
      lines.push(`• ${formatShortDate(t.occurredAt)} · ${formatAmount(t)}${detail}`);
    });
    if (confirmed.length > shown.length) {
      lines.push(
        "",
        `Te muestro los ${shown.length} más recientes. ¿Quieres ver los ${confirmed.length - shown.length} que faltan? Responde *sí* para verlos todos.`
      );
    }
  } else {
    lines.push("Todavía no tienes ningún movimiento confirmado de este comercio.");
  }

  if (pending.length > 0) {
    const pendingTotalLine = formatTotalsByCurrency(pending.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));
    lines.push(
      "",
      `⏳ *Aún sin confirmar* (${pending.length}, no suman al total de arriba — suman ${pendingTotalLine}):`
    );
    pending.forEach((t) => {
      const detail = t.description ? ` — ${t.description}` : "";
      lines.push(`• ${formatShortDate(t.occurredAt)} · ${formatAmount(t)}${detail}`);
    });
  }

  return { reply: lines.join("\n"), displayMerchant, shownCount: shown.length };
}

// Pregunta de seguimiento a una consulta por comercio: "¿en qué categoría
// están esos gastos?" — depende de recordar el último comercio consultado
// (ver MerchantQueryFollowUp), no repite el nombre del comercio.
const CATEGORY_GROUPING_FOLLOWUP_PHRASES = [
  "en que categoria estan", "en que categorias estan", "en que categoria van",
  "en que categoria caen", "que categoria tienen", "que categorias tienen",
];
function detectCategoryGroupingFollowup(normalizedText: string): boolean {
  return CATEGORY_GROUPING_FOLLOWUP_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

function buildCategoryGroupingReply(merchant: string, transactions: ConfirmedTxWithCategory[]): string {
  const byCategory = new Map<string, { name: string; icon: string; currency: string; amount: number; count: number }>();
  for (const t of transactions) {
    const name = t.category?.name ?? "Sin categoría";
    const icon = t.category ? CATEGORY_ICON_BY_NAME.get(t.category.name) ?? FALLBACK_CATEGORY_ICON : "❔";
    const key = `${t.categoryId ?? "sin-categoria"}|${t.currency}`;
    const entry = byCategory.get(key) ?? { name, icon, currency: t.currency, amount: 0, count: 0 };
    entry.amount += Number(t.amount);
    entry.count += 1;
    byCategory.set(key, entry);
  }
  const sorted = [...byCategory.values()].sort((a, b) => b.amount - a.amount);

  const lines = [`🏷️ *Categoría de tus gastos hacia ${merchant}*`, ""];
  sorted.forEach((c) => {
    lines.push(`${c.icon} ${c.name}: ${c.currency} ${c.amount.toFixed(2)} (${c.count} mov.)`);
  });
  if (sorted.length === 1) lines.push("", "Todos están en la misma categoría.");
  return lines.join("\n");
}

const SHOW_ALL_FOLLOWUP_PHRASES = ["todos", "todas", "muestra", "muestralos", "ver todos", "verlos todos", "dale", "detall"];
function wantsToSeeAllFollowUp(normalizedText: string): boolean {
  return detectConfirmWordIntent(normalizedText) || SHOW_ALL_FOLLOWUP_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

function declinesFollowUp(normalizedText: string): boolean {
  return REJECT_WORDS.has(normalizedText) || /asi esta bien|no gracias|nada mas|no hace falta|no es necesario/.test(normalizedText);
}

// Cuántas pendientes se detallan como máximo en el mensaje del resumen de
// pendientes — la aprobación en bloque y la revisión uno por uno siguen
// aplicando a TODAS, esto es solo para no mandar un mensaje kilométrico.
const PENDING_SUMMARY_DISPLAY_LIMIT = 15;

/** TODAS las PENDING_CONFIRMATION del usuario (no eliminadas), sin filtro de comercio ni de fecha, más recientes primero. */
async function findAllPendingConfirmation(userId: string): Promise<ConfirmedTxWithCategory[]> {
  return prisma.transaction.findMany({
    where: { userId, status: "PENDING_CONFIRMATION", deletedAt: null },
    include: { category: true },
    orderBy: { occurredAt: "desc" },
  });
}

/**
 * Lista numerada de pendientes (monto, comercio, categoría sugerida si la
 * tiene) con el total bien visible ANTES de preguntar si se aprueban en
 * bloque — el usuario tiene que ver cuánto dinero está en juego antes de
 * decidir, no después (aprobar en bloque modifica varias transacciones a
 * la vez, así que no se puede pedir esa confirmación a ciegas).
 */
function buildPendingSummaryReply(pending: ConfirmedTxWithCategory[]): string {
  const shown = pending.slice(0, PENDING_SUMMARY_DISPLAY_LIMIT);
  const totalLine = formatTotalsByCurrency(pending.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));

  const lines = [`📋 *Tienes ${pending.length} movimiento${pending.length === 1 ? "" : "s"} sin confirmar*`, ""];
  shown.forEach((t, i) => {
    const who = t.merchant || t.description || "Movimiento";
    const catLine = t.category
      ? ` · ${CATEGORY_ICON_BY_NAME.get(t.category.name) ?? FALLBACK_CATEGORY_ICON} ${t.category.name}`
      : " · sin categoría sugerida";
    lines.push(`${i + 1}. ${formatShortDate(t.occurredAt)} · ${formatAmount(t)} · ${who}${catLine}`);
  });
  if (pending.length > shown.length) {
    lines.push("", `...y ${pending.length - shown.length} más.`);
  }

  lines.push(
    "",
    `💰 *Suman en total:* ${totalLine}`,
    "",
    "¿Los apruebo todos de una vez, los revisamos uno por uno, o los dejamos pendientes por ahora?"
  );
  return lines.join("\n");
}

const APPROVE_ALL_PENDING_VERBS = ["aprueba", "apruebalas", "aprobarlas", "confirmalas", "confirmarlas", "aceptalas"];
function wantsApproveAllPending(normalizedText: string): boolean {
  return /\btodas?\b/.test(normalizedText) || APPROVE_ALL_PENDING_VERBS.some((verb) => normalizedText.includes(verb));
}

const REVIEW_ONE_BY_ONE_PHRASES = [
  "una por una", "uno por uno", "de una en una", "de uno en uno",
  "una a una", "uno a uno", "revisemoslas", "revisarlas de a una",
];
function wantsReviewOneByOne(normalizedText: string): boolean {
  return REVIEW_ONE_BY_ONE_PHRASES.some((phrase) => normalizedText.includes(phrase));
}

/**
 * Evalúa si una transacción YA EXISTENTE cumple el criterio de una regla
 * recién creada (Parte 3: aplicación retroactiva). Es un chequeo puntual de
 * un solo criterio contra un movimiento, distinto de findMatchingRuleCategory
 * en outlookSync.ts (que resuelve la prioridad entre VARIAS reglas activas
 * al categorizar un movimiento nuevo) — casos de uso distintos, no vale la
 * pena forzarlos a compartir una sola función.
 */
function transactionMatchesRule(
  rule: { type: string; value: string },
  t: { merchant: string | null; amount: unknown }
): boolean {
  switch (rule.type) {
    case "MERCHANT_CONTAINS":
      return !!t.merchant && normalizeText(t.merchant).includes(normalizeText(rule.value));
    case "AMOUNT_GREATER_THAN":
      return Number(t.amount) > parseFloat(rule.value);
    case "AMOUNT_LESS_THAN":
      return Number(t.amount) < parseFloat(rule.value);
    case "AMOUNT_EQUALS":
      return Math.abs(Number(t.amount) - parseFloat(rule.value)) < 0.01;
    default:
      return false;
  }
}

/** "gasto"/"traspaso"/"ingreso" (o botón equivalente) -> tipo de movimiento de la imagen. Sin match, null — nunca se adivina. */
function detectImageTransactionKind(normalizedText: string): "EXPENSE" | "TRANSFER" | "INCOME" | null {
  if (/\bgastos?\b/.test(normalizedText)) return "EXPENSE";
  if (/\btraspasos?\b|\bpropi[ao]s?\b/.test(normalizedText)) return "TRANSFER";
  if (/\bingresos?\b/.test(normalizedText)) return "INCOME";
  return null;
}

/**
 * Categoría para una captura clasificada como GASTO: reglas del usuario
 * (CategoryRule, evaluadas con el mismo criterio que la aplicación
 * retroactiva) primero, luego la sugerencia de Gemini, luego ninguna.
 */
async function resolveExpenseCategoryForImage(
  userId: string,
  recipient: string | undefined,
  amount: number,
  geminiSuggestedCategoryName: string | undefined,
  categories: { id: string; name: string }[]
): Promise<{ id: string; name: string } | undefined> {
  const activeRules = await prisma.categoryRule.findMany({
    where: { userId, isActive: true },
    include: { category: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  for (const rule of activeRules) {
    if (transactionMatchesRule(rule, { merchant: recipient ?? null, amount })) return rule.category;
  }

  if (geminiSuggestedCategoryName) {
    const match = categories.find((c) => normalizeText(c.name) === normalizeText(geminiSuggestedCategoryName));
    if (match) return match;
  }
  return undefined;
}

/**
 * Ya sabemos GASTO/TRASPASO/INGRESO — resuelve la categoría según lo
 * descrito arriba y crea la Transaction, reusando notifyPendingTransaction
 * para que entre al mismo flujo de confirmar/rechazar/corregir categoría
 * ya debuggeado en la Fase 3, en vez de reinventarlo para imágenes.
 */
async function finalizeImageTransaction(
  userId: string,
  userPhoneNumber: string | null | undefined,
  pending: PendingImageClassification,
  kind: "EXPENSE" | "TRANSFER" | "INCOME"
): Promise<void> {
  const categories = await getCategories(userId);
  let category: { id: string; name: string } | undefined;

  if (kind === "EXPENSE") {
    category = await resolveExpenseCategoryForImage(userId, pending.recipient, pending.amount, pending.suggestedCategory, categories);
  } else if (kind === "INCOME") {
    category = categories.find((c) => normalizeText(c.name) === normalizeText("Ingresos"));
  } else {
    // Un traspaso entre cuentas propias no es ni gasto ni ingreso real —
    // "No considerar" tiene excludeFromTotals=true, así que no infla
    // ninguno de los dos totales (matemáticamente correcto). "Movimientos
    // financieros" queda solo como fallback si el usuario archivó "No
    // considerar" (no debería pasar, es una de las 9 categorías base).
    category =
      categories.find((c) => normalizeText(c.name) === normalizeText("No considerar")) ??
      categories.find((c) => normalizeText(c.name) === normalizeText("Movimientos financieros"));
  }

  const merchant = pending.recipient || pending.bankOrWallet || "Transferencia";
  const descriptionParts: string[] = [];
  if (pending.bankOrWallet) descriptionParts.push(pending.bankOrWallet);
  if (pending.operationNumber) descriptionParts.push(`Op. ${pending.operationNumber}`);
  if (pending.fee) descriptionParts.push(`Comisión ${pending.currency} ${pending.fee.toFixed(2)}`);

  // TRASPASO no tiene su propio TransactionType en el schema (solo
  // EXPENSE/INCOME) — se guarda como EXPENSE, igual que ya se hace con las
  // "transferencias entre cuentas propias" existentes, para no inflar
  // ingresos con dinero que en realidad solo cambió de cuenta.
  const created = await prisma.transaction.create({
    data: {
      userId,
      type: kind === "INCOME" ? "INCOME" : "EXPENSE",
      amount: pending.amount,
      currency: pending.currency,
      merchant,
      description: descriptionParts.length > 0 ? descriptionParts.join(" · ") : undefined,
      categoryId: category?.id,
      source: "WHATSAPP_MANUAL",
      status: "PENDING_CONFIRMATION",
      occurredAt: pending.occurredAt,
    },
  });

  console.log(
    `WhatsApp: transacción creada desde captura de imagen -> ${created.id} (${kind}, ${pending.currency} ${pending.amount}, categoría: ${category?.name ?? "ninguna"})`
  );

  await notifyPendingTransaction(
    { ...created, category: category ? { name: category.name } : null },
    userPhoneNumber
  );
}

/** Total confirmado (todo el tiempo, no solo el mes) en una categoría, agrupado por moneda. */
async function sumConfirmedAllTimeByCurrency(userId: string, categoryId: string): Promise<string> {
  const rows = await prisma.transaction.findMany({
    where: { userId, categoryId, status: { in: ["CONFIRMED", "AUTO_CONFIRMED"] }, deletedAt: null },
    select: { currency: true, amount: true },
  });
  if (rows.length === 0) return "0.00";
  return formatTotalsByCurrency(rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) })));
}

function formatAmount(t: Pick<Transaction, "currency" | "amount">): string {
  return `${t.currency} ${Number(t.amount).toFixed(2)}`;
}

function formatShortDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")} ${MONTH_NAMES_ES[d.getMonth()]}`;
}

function formatBankLabel(bankKey: string): string {
  return bankKey.replace(/_/g, " ").toUpperCase();
}

/**
 * Arma el cuerpo del mensaje "¿Lo anotamos?": un ícono distinto por campo,
 * y si la transacción ya tiene categoría asignada, usa el ícono real de
 * esa categoría en vez de uno genérico.
 */
function buildNotificationBody(t: Transaction & { category?: { name: string } | null }): string {
  const lines = [
    "🧾 *Nuevo movimiento detectado*",
    "",
    `🏪 *Comercio:* ${t.merchant || t.description || "Sin nombre"}`,
    `💵 *Monto:* ${formatAmount(t)}`,
  ];

  if (t.category) {
    const icon = CATEGORY_ICON_BY_NAME.get(t.category.name) ?? FALLBACK_CATEGORY_ICON;
    lines.push(`${icon} *Categoría:* ${t.category.name}`);
  }

  lines.push(`🗓️ *Fecha:* ${formatShortDate(t.occurredAt)}`);
  if (t.bankKey) lines.push(`🏛️ *Banco:* ${formatBankLabel(t.bankKey)}`);

  lines.push("", "¿Lo registramos?");

  return lines.join("\n");
}

/** Suma simple de lo confirmado en una categoría durante el mes actual. */
async function sumConfirmedThisMonth(userId: string, categoryId: string): Promise<number | null> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const result = await prisma.transaction.aggregate({
    where: {
      userId,
      categoryId,
      status: { in: ["CONFIRMED", "AUTO_CONFIRMED"] },
      deletedAt: null,
      occurredAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });

  return result._sum.amount ? Number(result._sum.amount) : null;
}

/**
 * Marca la transacción como CONFIRMED (opcionalmente reasignando su
 * categoría) y arma el mensaje de respuesta, incluyendo el total del mes
 * en esa categoría cuando hay una. Se usa tanto para la confirmación
 * simple ("sí") como para la corrección de categoría por texto libre.
 */
async function confirmTransaction(
  pending: PendingTransaction,
  userId: string,
  categoryOverride?: { id: string; name: string }
): Promise<string> {
  await prisma.transaction.update({
    where: { id: pending.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      ...(categoryOverride ? { categoryId: categoryOverride.id } : {}),
    },
  });

  const who = pending.merchant || pending.description || "el movimiento";
  let reply = `✅ *Anotado:* ${formatAmount(pending)} en ${who}.`;

  const categoryId = categoryOverride?.id ?? pending.categoryId;
  const categoryName = categoryOverride?.name ?? pending.category?.name;
  if (categoryId && categoryName) {
    const monthTotal = await sumConfirmedThisMonth(userId, categoryId);
    if (monthTotal !== null) {
      reply += `\nLlevas ${pending.currency} ${monthTotal.toFixed(2)} en ${categoryName} este mes.`;
    }
  }

  return reply;
}

/**
 * Cambia la categoría de un gasto que YA está CONFIRMED (identificado por
 * detalles, ej. "cambia el gasto de Oscar Saavedra a Yape/Plin") — no
 * requiere confirmación extra porque, a diferencia de eliminar, no es
 * destructivo ni pierde datos.
 */
async function recategorizeConfirmedTransaction(
  pending: PendingTransaction,
  userId: string,
  from: string,
  category: { id: string; name: string }
): Promise<void> {
  await prisma.transaction.update({
    where: { id: pending.id },
    data: { categoryId: category.id },
  });

  const who = pending.merchant || pending.description || "el movimiento";
  const icon = CATEGORY_ICON_BY_NAME.get(category.name) ?? FALLBACK_CATEGORY_ICON;
  let reply = `✅ *Listo:* ${formatAmount(pending)} en ${who} ahora está en ${icon} *${category.name}*.`;

  const monthTotal = await sumConfirmedThisMonth(userId, category.id);
  if (monthTotal !== null) {
    reply += `\nLlevas ${pending.currency} ${monthTotal.toFixed(2)} en ${category.name} este mes.`;
  }

  await sendTextMessage(from, reply);
}

async function rejectTransaction(pending: PendingTransaction, from: string): Promise<void> {
  await prisma.transaction.update({
    where: { id: pending.id },
    data: { status: "REJECTED" },
  });
  await sendTextMessage(from, "Entendido, no lo anotamos. 👍");
}

/**
 * Elimina (lógicamente) un gasto ya CONFIRMED: setea deletedAt, sin tocar
 * el status. Es reversible — ver restoreDeletedTransaction. Se llama solo
 * después de la confirmación explícita del usuario.
 */
/**
 * Línea "🏷️ Nombre de categoría" para mostrar en mensajes de eliminar/
 * restaurar, o "" si no hay categoría (ni asignada ni corregida). `override`
 * gana sobre la categoría que ya tenía la transacción, para reflejar una
 * corrección aplicada en el mismo mensaje que restaura.
 */
function categoryLine(pending: PendingTransaction, override?: { name: string }): string {
  const name = override?.name ?? pending.category?.name;
  if (!name) return "";
  const icon = CATEGORY_ICON_BY_NAME.get(name) ?? FALLBACK_CATEGORY_ICON;
  return `\n${icon} ${name}`;
}

async function deleteConfirmedTransaction(pending: PendingTransaction, from: string): Promise<void> {
  await prisma.transaction.update({
    where: { id: pending.id },
    data: { deletedAt: new Date() },
  });
  const who = pending.merchant || pending.description || "el movimiento";
  await sendTextMessage(from, `🗑️ *Eliminado:* ${formatAmount(pending)} en ${who}.${categoryLine(pending)}`);
}

/**
 * Revierte un borrado lógico (deletedAt -> null), opcionalmente
 * reasignando la categoría si el mensaje que pidió restaurar también
 * mencionó una corrección (ej. "vuelve a considerarlo, pero en transporte").
 */
async function restoreDeletedTransaction(
  pending: PendingTransaction,
  from: string,
  categoryOverride?: { id: string; name: string }
): Promise<void> {
  await prisma.transaction.update({
    where: { id: pending.id },
    data: {
      deletedAt: null,
      ...(categoryOverride ? { categoryId: categoryOverride.id } : {}),
    },
  });
  const who = pending.merchant || pending.description || "el movimiento";
  await sendTextMessage(from, `♻️ *Restaurado:* ${formatAmount(pending)} en ${who}.${categoryLine(pending, categoryOverride)}`);
}

/** Ejecuta una intención ya decidida (confirmar, rechazar, eliminar o restaurar) sobre una transacción específica. */
async function applyResolvedIntent(
  pending: PendingTransaction,
  userId: string,
  from: string,
  intent: ResolvedIntent
): Promise<void> {
  if (intent.action === "reject") {
    await rejectTransaction(pending, from);
    return;
  }
  if (intent.action === "delete") {
    await deleteConfirmedTransaction(pending, from);
    return;
  }
  if (intent.action === "restore") {
    await restoreDeletedTransaction(pending, from, intent.category);
    return;
  }
  if (intent.action === "recategorize") {
    if (intent.category) {
      await recategorizeConfirmedTransaction(pending, userId, from, intent.category);
    }
    return;
  }
  const reply = await confirmTransaction(pending, userId, intent.category);
  await sendTextMessage(from, reply);
}

/**
 * Decide qué hacer con una transacción ya identificada cuando el mensaje
 * en sí no trae una intención clara detectada de antemano: sí/no exactos,
 * o una corrección de categoría por alias. Es el comportamiento "clásico"
 * (sin inferencia de intención), usado como último recurso.
 */
async function handleFreeformDecision(
  pending: PendingTransaction,
  userId: string,
  from: string,
  normalized: string
): Promise<void> {
  if (detectConfirmWordIntent(normalized)) {
    const reply = await confirmTransaction(pending, userId);
    await sendTextMessage(from, reply);
    return;
  }

  if (REJECT_WORDS.has(normalized) || detectRejectIntent(normalized)) {
    await rejectTransaction(pending, from);
    return;
  }

  const categories = await getCategories(userId);
  const matchedCategory = resolveCategoryFromText(normalized, categories);

  if (matchedCategory) {
    const reply = await confirmTransaction(pending, userId, matchedCategory);
    await sendTextMessage(from, reply);
    return;
  }

  await sendTextMessage(
    from,
    'No entendí tu respuesta. Usa los botones o responde *Sí* o *No* para confirmar o descartar tu último movimiento, o dime en qué categoría va, por ejemplo "anótalo en transporte".'
  );
}

/**
 * Procesa la respuesta de un usuario a la pregunta "¿Lo anotamos?" mandada
 * por notifyPendingTransaction — texto libre ("sí"/"no"), el click en uno
 * de los botones interactivos, o una identificación por lenguaje natural
 * (ej. "anotar el gasto de ayer de 4 soles a Virgilio", que identifica Y
 * confirma en el mismo mensaje). Se llama desde POST /webhook.
 */
export async function handleIncomingMessage(
  from: string,
  text: string,
  contextMessageId?: string | null
): Promise<void> {
  const user = await findUserByWhatsappNumber(from);
  if (!user) {
    console.log(`WhatsApp: mensaje de un número no registrado (${from}), se ignora.`);
    return;
  }

  const normalized = normalizeText(text);

  // -1) ¿Hay una clasificación de imagen pendiente (Fase 4: el usuario
  // reenvió una captura de transferencia y le preguntamos GASTO/TRASPASO/
  // INGRESO)? Va con la MÁXIMA prioridad de todo el archivo, antes incluso
  // que crear regla — misma lección que costaron los bugs reales de la
  // Fase 3: una pregunta pendiente del bot nunca debe caer en otra
  // interpretación por accidente. Si la respuesta no es clara, se vuelve a
  // preguntar (nunca se adivina), y el estado NO se borra para poder seguir
  // esperando la respuesta correcta.
  const pendingImage = pendingImageByUserId.get(user.id);
  if (pendingImage) {
    const imageExpired = Date.now() - pendingImage.createdAt > PENDING_IMAGE_TTL_MS;
    if (imageExpired) {
      pendingImageByUserId.delete(user.id);
      console.log(`WhatsApp: había una clasificación de imagen pendiente para ${from} pero expiró (TTL), se descarta.`);
    } else {
      const kind = detectImageTransactionKind(normalized);
      if (kind) {
        pendingImageByUserId.delete(user.id);
        console.log(`WhatsApp: clasificación de imagen resuelta -> ${kind}.`);
        await finalizeImageTransaction(user.id, user.phoneNumber, pendingImage, kind);
        return;
      }
      console.log(`WhatsApp: había una clasificación de imagen pendiente para ${from}, pero "${normalized}" no fue gasto/traspaso/ingreso claro; se vuelve a preguntar.`);
      await sendTextMessage(from, "No entendí. ¿Ese movimiento es un *gasto*, un *traspaso* entre tus propias cuentas, o un *ingreso*?");
      return;
    }
  }

  // 0) Intención de CREAR UNA REGLA de categorización automática — se
  // chequea primero entre las detecciones de intención "normales" (después
  // de la clasificación de imagen pendiente, que tiene prioridad absoluta):
  // sus frases disparadoras ("todo gasto", "siempre que", "gastos
  // mayores"...) no se cruzan con ninguna otra intención de este archivo,
  // pero mensajes como "todo gasto en Taxi va a Movimientos financieros"
  // SÍ calzan con los patrones de la consulta por categoría/comercio de
  // más abajo (mencionan una categoría o un comercio) — así que crear
  // regla tiene que ganar primero entre esas.
  if (detectCreateRuleIntent(normalized)) {
    console.log(`WhatsApp: intención de CREAR REGLA detectada de ${from}.`);

    const merchantCriterion = extractMerchantRuleCriterion(normalized);
    const amountCriterion = extractAmountRuleCriterion(normalized);
    const categories = await getCategories(user.id);
    const matchedCategory = resolveRuleTargetCategory(normalized, categories);

    const hasClearCriterion = (!!merchantCriterion) !== (!!amountCriterion); // exactamente uno de los dos, no ambos ni ninguno

    if (!matchedCategory || !hasClearCriterion) {
      await sendTextMessage(
        from,
        'No me quedó claro cómo armar esa regla. Decime algo como "todo gasto en Burger King va a Alimentación" o "los gastos mayores a 100 soles van a Movimientos financieros".'
      );
      return;
    }

    const ruleData = merchantCriterion
      ? { type: "MERCHANT_CONTAINS" as const, value: merchantCriterion, description: `el comercio contenga "${merchantCriterion}"` }
      : { type: amountCriterion!.type, value: String(amountCriterion!.amount), description: `el monto sea ${amountCriterion!.label} ${amountCriterion!.amount}` };

    const rule = await prisma.categoryRule.create({
      data: {
        userId: user.id,
        type: ruleData.type,
        value: ruleData.value,
        categoryId: matchedCategory.id,
        source: "WHATSAPP",
      },
    });

    console.log(`WhatsApp: regla creada -> ${rule.id} (${ruleData.type} "${ruleData.value}" -> ${matchedCategory.name})`);
    await sendTextMessage(
      from,
      `📏 Listo, apunté la regla: de ahora en más, cuando ${ruleData.description}, lo mando directo a *${matchedCategory.name}*. ` +
        `La puedes ver o editar cuando quieras en el dashboard, en la sección *Reglas*.`
    );

    // Parte 3: ¿esta regla también aplica a movimientos que ya existen?
    // Modifica datos reales en bloque, así que solo se pregunta — nunca se
    // aplica sola. Si no hay ningún movimiento existente que coincida, no
    // hay nada que preguntar.
    const existingConfirmed = await prisma.transaction.findMany({
      where: { userId: user.id, status: "CONFIRMED", deletedAt: null },
      include: { category: true },
    });
    const retroactiveMatches = existingConfirmed.filter((t) => transactionMatchesRule(ruleData, t));

    if (retroactiveMatches.length > 0) {
      const currentBreakdown = new Map<string, number>();
      for (const t of retroactiveMatches) {
        const name = t.category?.name ?? "Sin categoría";
        currentBreakdown.set(name, (currentBreakdown.get(name) ?? 0) + 1);
      }
      const breakdownLine = [...currentBreakdown.entries()].map(([name, count]) => `${name} (${count})`).join(", ");
      const n = retroactiveMatches.length;

      console.log(`WhatsApp: la regla nueva también coincide con ${n} movimiento(s) ya existente(s), preguntando si aplicarla retroactivamente.`);
      await sendTextMessage(
        from,
        `Ojo: también tienes ${n} gasto${n === 1 ? "" : "s"} ya registrado${n === 1 ? "" : "s"} que cumple${n === 1 ? "" : "n"} esta regla, ` +
          `ahorita en ${breakdownLine}. ¿Los paso también a *${matchedCategory.name}*? Responde *sí* para actualizarlos, o *no* para dejarlos como están.`
      );

      followUpByUserId.set(user.id, {
        createdAt: Date.now(),
        context: {
          type: "retroactive_rule",
          categoryId: matchedCategory.id,
          categoryName: matchedCategory.name,
          transactionIds: retroactiveMatches.map((t) => t.id),
        },
      });
    }

    return;
  }

  // 0.1) Intención de RESUMEN DE PENDIENTES — TODAS las PENDING_CONFIRMATION
  // del usuario, sin filtro de fecha ni comercio. Se chequea ANTES que el
  // resumen normal y que la consulta por categoría porque una frase como
  // "resumen de pendientes" también calza con ambos ("resumen de", o
  // "pendientes" mal interpretado como categoría), y esta es más específica.
  if (detectPendingSummaryIntent(normalized)) {
    console.log(`WhatsApp: intención de RESUMEN DE PENDIENTES detectada de ${from}.`);
    const allPending = await findAllPendingConfirmation(user.id);

    if (allPending.length === 0) {
      await sendTextMessage(from, "No tienes nada pendiente por confirmar ahora mismo. 👍");
      return;
    }

    await sendTextMessage(from, buildPendingSummaryReply(allPending));
    followUpByUserId.set(user.id, {
      createdAt: Date.now(),
      context: { type: "pending_review", transactionIds: allPending.map((p) => p.id) },
    });
    return;
  }

  // 0.15) Consulta de detalle por CATEGORÍA — otra intención nueva de solo
  // lectura. Ya pasó la detección de CREAR REGLA, así que un mensaje como
  // "todo gasto en Taxi va a Movimientos financieros" no llega hasta acá.
  // Se chequea ANTES que el resumen general (0.2) porque comparten
  // vocabulario ("cuánto gasté en X" también contiene "cuanto gaste", una
  // de las SUMMARY_INTENT_PHRASES) — si X resuelve a una categoría real,
  // gana esta consulta más específica; si no, sigue el flujo normal.
  const categoriesForQuery = await getCategories(user.id);
  const categoryQuery = extractCategoryQuery(normalized, categoriesForQuery);
  if (categoryQuery) {
    const { category, dateRange } = categoryQuery;
    console.log(`WhatsApp: intención de CONSULTA POR CATEGORÍA detectada de ${from} ("${category.name}", período: ${dateRange.label}).`);
    const categoryMatches = await findConfirmedByCategory(user.id, category.id, dateRange);
    await sendTextMessage(from, buildCategoryQueryReply(category, categoryMatches, dateRange));

    if (categoryMatches.length > 0) {
      followUpByUserId.set(user.id, {
        createdAt: Date.now(),
        context: { type: "category_query", categoryName: category.name, transactionIds: categoryMatches.map((m) => m.id) },
      });
    }
    return;
  }

  // 0.17) Comando manual de prueba del REPORTE SEMANAL (imagen) — se chequea
  // ANTES que el resumen general (0.2) por el mismo motivo que la consulta
  // por categoría: "resumen semanal" también contiene "resumen", una de las
  // SUMMARY_INTENT_PHRASES. Deliberadamente no espera al cron del domingo
  // 8pm para poder probarlo en cualquier momento.
  if (detectWeeklyReportIntent(normalized)) {
    console.log(`WhatsApp: pedido manual de REPORTE SEMANAL de ${from}.`);
    const weekStart = currentWeekStart();
    await sendWeeklyReportToUser(user, weekStart, new Date());
    return;
  }

  // 0.2) Intención de RESUMEN/CONSULTA general — es una intención completamente
  // distinta (de solo lectura) a confirmar/rechazar/identificar un
  // movimiento puntual, así que se resuelve antes que cualquier otra cosa
  // y no toca ningún estado de desambiguación pendiente.
  if (detectSummaryIntent(normalized)) {
    console.log(`WhatsApp: intención de RESUMEN detectada de ${from}.`);
    const reply = await buildSummaryReply(user.id, normalized, user.name);
    await sendTextMessage(from, reply);
    return;
  }

  // 0.3) Consulta de detalle de gastos hacia un comercio puntual — otra
  // intención nueva de solo lectura, se resuelve antes de tocar cualquier
  // estado pendiente. Va después de la detección de CREAR REGLA y de la
  // consulta por categoría porque comparten conectores ("gastos en X").
  const merchantQuery = extractMerchantQuery(normalized);
  if (merchantQuery) {
    const { merchant: merchantQueryFragment, dateRange } = merchantQuery;
    console.log(
      `WhatsApp: intención de CONSULTA POR COMERCIO detectada de ${from} ("${merchantQueryFragment}"${dateRange ? `, período: ${dateRange.label}` : ""}).`
    );
    const { confirmed: confirmedMatches, pending: pendingMatches } = await findConfirmedByMerchant(
      user.id,
      merchantQueryFragment,
      dateRange
    );

    if (confirmedMatches.length === 0 && pendingMatches.length === 0) {
      const periodSuffix = dateRange ? ` en ${dateRange.label}` : "";
      await sendTextMessage(from, `No encontré gastos hacia *${capitalize(merchantQueryFragment)}*${periodSuffix}.`);
      return;
    }

    const { reply, displayMerchant, shownCount } = buildMerchantQueryReply(
      merchantQueryFragment,
      confirmedMatches,
      pendingMatches,
      dateRange
    );
    await sendTextMessage(from, reply);

    followUpByUserId.set(user.id, {
      createdAt: Date.now(),
      context: {
        type: "merchant_query",
        merchant: displayMerchant,
        transactionIds: confirmedMatches.map((m) => m.id),
        shownCount,
      },
    });
    return;
  }

  // 0.35) ¿Estábamos esperando una respuesta de seguimiento a una consulta
  // por comercio/categoría (Parte 1/2), a la pregunta de aplicar una regla
  // nueva retroactivamente (Parte 3), o a la revisión de pendientes? Esto
  // se resuelve ANTES que el swipe-reply (context.id, ver 0.4 más abajo) a
  // propósito: si el bot le hizo una pregunta directa al usuario y está
  // esperando esa respuesta puntual, esa pregunta pendiente tiene prioridad
  // sobre cualquier otra señal — incluido un context.id que, si no
  // corresponde a ninguna transacción (típico: el mensaje que citó no era
  // una notificación de transacción sino un mensaje suelto de consulta),
  // antes dejaba caer el flujo hasta el fallback genérico y terminaba
  // confirmando la transacción pendiente más reciente por error (bug real:
  // swipe-reply "sí" a "Alimentación — este mes..." terminó confirmando un
  // gasto de Olga Huaman sin relación alguna). Mismo mecanismo que la
  // desambiguación de abajo (0.36: Map en memoria, TTL, se consume siempre
  // al leer) pero en un Map separado porque la forma de los datos es distinta.
  const followUp = followUpByUserId.get(user.id);
  if (followUp) {
    followUpByUserId.delete(user.id); // se consume siempre; se vuelve a guardar más abajo si aplica
    const followUpExpired = Date.now() - followUp.createdAt > FOLLOWUP_TTL_MS;

    if (!followUpExpired && followUp.context.type === "retroactive_rule") {
      const ctx = followUp.context;
      if (detectConfirmIntent(normalized)) {
        const result = await prisma.transaction.updateMany({
          where: { id: { in: ctx.transactionIds } },
          data: { categoryId: ctx.categoryId },
        });
        const newTotal = await sumConfirmedAllTimeByCurrency(user.id, ctx.categoryId);
        console.log(`WhatsApp: aplicación RETROACTIVA confirmada -> ${result.count} movimiento(s) actualizados a ${ctx.categoryName}.`);
        await sendTextMessage(
          from,
          `✅ Listo, actualicé ${result.count} movimiento${result.count === 1 ? "" : "s"} a *${ctx.categoryName}*. ` +
            `Ahora llevas ${newTotal} en total en esa categoría.`
        );
      } else {
        console.log(`WhatsApp: aplicación RETROACTIVA rechazada, se dejan los ${ctx.transactionIds.length} movimientos existentes tal cual.`);
        await sendTextMessage(from, "Entendido, dejo esos movimientos como están. Solo los nuevos usarán la regla.");
      }
      return;
    }

    if (!followUpExpired && followUp.context.type === "merchant_query") {
      const ctx = followUp.context;

      if (detectCategoryGroupingFollowup(normalized)) {
        const transactions = await prisma.transaction.findMany({
          where: { id: { in: ctx.transactionIds } },
          include: { category: true },
        });
        console.log(`WhatsApp: seguimiento "en qué categoría están" para el comercio "${ctx.merchant}".`);
        await sendTextMessage(from, buildCategoryGroupingReply(ctx.merchant, transactions));
        followUpByUserId.set(user.id, { context: ctx, createdAt: Date.now() }); // se mantiene por si preguntan algo más
        return;
      }

      if (wantsToSeeAllFollowUp(normalized)) {
        if (ctx.transactionIds.length <= ctx.shownCount) {
          await sendTextMessage(from, "Ya te había mostrado todos los que encontré, no hay más.");
          return;
        }
        const remaining = await prisma.transaction.findMany({
          where: { id: { in: ctx.transactionIds.slice(ctx.shownCount) } },
          include: { category: true },
          orderBy: { occurredAt: "desc" },
        });
        console.log(`WhatsApp: seguimiento "muéstralos todos" -> ${remaining.length} movimiento(s) restantes de "${ctx.merchant}".`);
        const lines = [`🔎 *Resto de gastos hacia ${ctx.merchant}*`, ""];
        remaining.forEach((t) => {
          const detail = t.description ? ` — ${t.description}` : "";
          lines.push(`• ${formatShortDate(t.occurredAt)} · ${formatAmount(t)}${detail}`);
        });
        await sendTextMessage(from, lines.join("\n"));
        return;
      }

      if (declinesFollowUp(normalized)) {
        await sendTextMessage(from, "Listo, cualquier cosa me dices. 👍");
        return;
      }
      // No fue una respuesta de seguimiento reconocible: seguimos el flujo normal de abajo.
    }

    if (!followUpExpired && followUp.context.type === "pending_review") {
      const ctx = followUp.context;

      if (wantsApproveAllPending(normalized)) {
        const stillPending = await prisma.transaction.findMany({
          where: { id: { in: ctx.transactionIds }, status: "PENDING_CONFIRMATION" },
          include: { category: true },
        });
        if (stillPending.length === 0) {
          await sendTextMessage(from, "Esos movimientos ya no están pendientes, no hay nada que aprobar.");
          return;
        }
        await prisma.transaction.updateMany({
          where: { id: { in: stillPending.map((p) => p.id) } },
          data: { status: "CONFIRMED", confirmedAt: new Date() },
        });
        const totalLine = formatTotalsByCurrency(stillPending.map((t) => ({ currency: t.currency, amount: Number(t.amount) })));
        console.log(`WhatsApp: aprobación EN BLOQUE de ${stillPending.length} pendiente(s) -> CONFIRMED.`);
        await sendTextMessage(
          from,
          `✅ Listo, confirmé ${stillPending.length} movimiento${stillPending.length === 1 ? "" : "s"} por un total de ${totalLine}.`
        );
        return;
      }

      if (wantsReviewOneByOne(normalized)) {
        const firstId = ctx.transactionIds[0];
        const firstPending = await prisma.transaction.findFirst({
          where: { id: firstId, userId: user.id, status: "PENDING_CONFIRMATION" },
          include: { category: true },
        });
        if (!firstPending) {
          await sendTextMessage(from, "Ese movimiento ya no está pendiente.");
          return;
        }
        console.log(`WhatsApp: revisión UNO POR UNO iniciada -> ${firstPending.id}`);
        await notifyPendingTransaction(firstPending, from);
        return;
      }

      if (declinesFollowUp(normalized)) {
        await sendTextMessage(from, "Sin problema, ahí quedan cuando quieras revisarlos.");
        return;
      }
      // No fue una respuesta de seguimiento reconocible: seguimos el flujo normal de abajo.
    }

    if (!followUpExpired && followUp.context.type === "category_query") {
      const ctx = followUp.context;

      if (wantsToSeeAllFollowUp(normalized)) {
        const transactions = await prisma.transaction.findMany({
          where: { id: { in: ctx.transactionIds } },
          include: { category: true },
          orderBy: { occurredAt: "desc" },
        });
        console.log(`WhatsApp: seguimiento "detállalos" -> ${transactions.length} movimiento(s) de "${ctx.categoryName}".`);
        await sendTextMessage(from, buildCategoryItemizedReply({ name: ctx.categoryName }, transactions));
        return;
      }

      if (declinesFollowUp(normalized)) {
        await sendTextMessage(from, "Listo, cualquier cosa me dices. 👍");
        return;
      }
      // No fue una respuesta de seguimiento reconocible: seguimos el flujo normal de abajo.
    }
  }

  // 0.36) ¿Estábamos esperando una respuesta puntual (desambiguación o
  // confirmación explícita) sobre una transacción ya identificada? Mismo
  // principio que 0.35: una pregunta pendiente del bot gana sobre el
  // swipe-reply si el context.id no aporta nada más específico.
  const state = disambiguationByUserId.get(user.id);
  if (state) {
    disambiguationByUserId.delete(user.id); // se consume siempre; si hace falta, se vuelve a crear más abajo
    const expired = Date.now() - state.createdAt > DISAMBIGUATION_TTL_MS;

    if (expired) {
      console.log("WhatsApp: había un estado pendiente pero expiró (TTL), se descarta.");
    } else if (state.transactionIds.length === 1) {
      // Un solo candidato: esperábamos sí/no/categoría explícitos para ESTA transacción
      // (o, si la intención guardada es "delete", un sí/no puntual para confirmar el borrado).
      // No filtramos por status acá: la transacción puede estar en cualquiera de los tres
      // (PENDING_CONFIRMATION, CONFIRMED o REJECTED) según qué la haya generado.
      const pending = await prisma.transaction.findFirst({
        where: { id: state.transactionIds[0], userId: user.id },
        include: { category: true },
      });
      if (pending) {
        if (state.intent?.action === "delete") {
          if (pending.status !== "CONFIRMED" || pending.deletedAt) {
            console.log(`WhatsApp: se pidió confirmar eliminación de ${pending.id}, pero ya no aplica (status ${pending.status}, deletedAt ${pending.deletedAt}).`);
            await sendTextMessage(from, "Ese movimiento ya cambió de estado, no hay nada que eliminar.");
            return;
          }
          if (detectConfirmWordIntent(normalized)) {
            console.log(`WhatsApp: confirmación de ELIMINACIÓN recibida -> borrando transacción ${pending.id}`);
            await deleteConfirmedTransaction(pending, from);
          } else {
            console.log(`WhatsApp: no se confirmó la eliminación de ${pending.id}, se cancela.`);
            await sendTextMessage(from, "No se eliminó nada. El gasto sigue registrado.");
          }
          return;
        }
        if (state.intent?.action === "restore") {
          if (!pending.deletedAt) {
            console.log(`WhatsApp: se pidió confirmar restauración de ${pending.id}, pero ya no está eliminado.`);
            await sendTextMessage(from, "Ese movimiento ya está activo, no hay nada que restaurar.");
            return;
          }
          if (detectConfirmWordIntent(normalized)) {
            // La categoría puede haberse mencionado en el mensaje original que
            // disparó la restauración (state.intent.category) o recién ahora,
            // en esta confirmación (ej. "sí, pero en transporte") — esta última gana.
            const categories = await getCategories(user.id);
            const matchedCategory = resolveCategoryFromText(normalized, categories);
            console.log(`WhatsApp: confirmación de RESTAURACIÓN recibida -> restaurando transacción ${pending.id}`);
            await restoreDeletedTransaction(pending, from, matchedCategory ?? state.intent.category);
          } else {
            console.log(`WhatsApp: no se confirmó la restauración de ${pending.id}, se cancela.`);
            await sendTextMessage(from, "No se restauró nada.");
          }
          return;
        }
        console.log(`WhatsApp: resolviendo confirmación explícita pendiente -> transacción ${pending.id}`);
        await handleFreeformDecision(pending, user.id, from, normalized);
        return;
      }
      console.log(`WhatsApp: la transacción del estado pendiente ya no existe.`);
    } else {
      const choice = /^\d+$/.test(normalized) ? parseInt(normalized, 10) : null;
      if (choice && choice >= 1 && choice <= state.transactionIds.length) {
        const chosenId = state.transactionIds[choice - 1];
        const pending = await prisma.transaction.findFirst({
          where: { id: chosenId, userId: user.id },
          include: { category: true },
        });
        if (pending) {
          if (state.intent) {
            console.log(
              `WhatsApp: desambiguación resuelta -> opción ${choice} -> transacción ${pending.id}, ` +
                `aplicando intención guardada (${state.intent.action}).`
            );
            await applyResolvedIntent(pending, user.id, from, state.intent);
          } else {
            console.log(
              `WhatsApp: desambiguación resuelta -> opción ${choice} -> transacción ${pending.id}, ` +
                `sin intención clara, pidiendo confirmación explícita.`
            );
            disambiguationByUserId.set(user.id, { transactionIds: [pending.id], intent: null, createdAt: Date.now() });
            await sendTextMessage(from, buildConfirmPrompt(pending));
          }
          return;
        }
        console.log("WhatsApp: eligió una opción de la desambiguación, pero esa transacción ya no está en el status esperado.");
      } else {
        console.log("WhatsApp: había una desambiguación pendiente pero la respuesta no fue un número válido, se descarta.");
      }
    }
  }

  // 0.4) Swipe-reply (context.id) a la notificación de una transacción, sin
  // importar su status actual. Se evalúa DESPUÉS de 0.35/0.36 a propósito:
  // si no había ninguna pregunta pendiente esperando respuesta, el
  // context.id es la señal más fuerte de a cuál transacción se refiere el
  // usuario, más fuerte que cualquier identificación por texto (monto/
  // nombre/fecha) de los pasos de abajo.
  //
  // `contextIdFailedToResolve` (declarada afuera del if para que el paso 2
  // la vea) marca el caso en que SÍ llegó un context.id pero no coincidió
  // con ninguna transacción (típico: la notificación original nunca guardó
  // su lastNotificationMessageId, o es muy vieja). Es una señal fuerte de
  // que el usuario quiso responder a una transacción PUNTUAL y específica
  // — el paso 2 (fallback final) la usa para NO adivinar "la más reciente"
  // a ciegas en ese caso, en vez de eso pide que aclare. Bug real que esto
  // corrige: swipe-reply a "Oscar Saavedra C" (sin lastNotificationMessageId
  // guardado) con el texto "anotar en yape plin" — sin nombre de comercio en
  // el texto, cayó al fallback ciego y confirmó "Olga Huaman" (otra
  // transacción, la más reciente por 7 segundos) con la categoría
  // mencionada, sin relación alguna con lo que el usuario quiso decir.
  let contextIdFailedToResolve = false;
  if (contextMessageId) {
    const byContext = await prisma.transaction.findFirst({
      where: { userId: user.id, lastNotificationMessageId: contextMessageId },
      include: { category: true },
    });

    if (byContext) {
      console.log(
        `WhatsApp: match EXACTO por context.id (${contextMessageId}) -> transacción ${byContext.id} (status actual: ${byContext.status})`
      );

      if (byContext.status === "PENDING_CONFIRMATION") {
        await handleFreeformDecision(byContext, user.id, from, normalized);
        return;
      }

      if (byContext.status === "CONFIRMED" && byContext.deletedAt) {
        // Ya fue eliminado (soft-delete): ofrecemos restaurarlo, no eliminarlo de nuevo.
        const categories = await getCategories(user.id);
        const matchedCategory = resolveCategoryFromText(normalized, categories);

        if (detectConfirmIntent(normalized)) {
          console.log(`WhatsApp: swipe-reply a CONFIRMED-eliminado + intención RESTAURAR -> ${byContext.id}`);
          await restoreDeletedTransaction(byContext, from, matchedCategory ?? undefined);
          return;
        }
        disambiguationByUserId.set(user.id, {
          transactionIds: [byContext.id],
          intent: { action: "restore", category: matchedCategory ?? undefined },
          createdAt: Date.now(),
        });
        console.log(`WhatsApp: swipe-reply a CONFIRMED-eliminado sin intención clara -> ${byContext.id}, preguntando si restaurar.`);
        await sendTextMessage(from, buildRestorePrompt(byContext));
        return;
      }

      if (byContext.status === "CONFIRMED") {
        if (detectDeleteConfirmedIntent(normalized)) {
          disambiguationByUserId.set(user.id, {
            transactionIds: [byContext.id],
            intent: { action: "delete" },
            createdAt: Date.now(),
          });
          console.log(`WhatsApp: swipe-reply a CONFIRMED + intención ELIMINAR -> ${byContext.id}, pidiendo confirmación explícita.`);
          await sendTextMessage(from, buildDeleteConfirmPrompt(byContext));
          return;
        }

        // No es "eliminar" — ¿el mensaje menciona una categoría real? Si sí,
        // la intención es RECATEGORIZAR esta transacción puntual (identificada
        // por context.id, no hace falta buscarla por detalles). Se aplica
        // directo, sin pedir confirmación extra (no es destructivo). Bug real
        // que esto corrige: swipe-reply a una notificación CONFIRMED con
        // "anotar en alimentación" solo ofrecía "¿eliminar?", ignorando que
        // el usuario quiso corregir la categoría.
        const categoriesForRecategorize = await getCategories(user.id);
        const recategorizeTarget = resolveCategoryFromText(normalized, categoriesForRecategorize);
        if (recategorizeTarget) {
          console.log(`WhatsApp: swipe-reply a CONFIRMED + categoría reconocida -> recategorizando ${byContext.id} a ${recategorizeTarget.name}.`);
          await recategorizeConfirmedTransaction(byContext, user.id, from, recategorizeTarget);
          return;
        }

        disambiguationByUserId.set(user.id, {
          transactionIds: [byContext.id],
          intent: { action: "delete" },
          createdAt: Date.now(),
        });
        console.log(`WhatsApp: swipe-reply a CONFIRMED sin intención clara -> ${byContext.id}, preguntando si eliminar.`);
        await sendTextMessage(from, buildAlreadyConfirmedPrompt(byContext));
        return;
      }

      if (byContext.status === "REJECTED") {
        if (detectConfirmIntent(normalized)) {
          const categories = await getCategories(user.id);
          const matchedCategory = resolveCategoryFromText(normalized, categories);
          console.log(`WhatsApp: swipe-reply a REJECTED + intención CONFIRMAR -> revirtiendo ${byContext.id} a CONFIRMED.`);
          const reply = await confirmTransaction(byContext, user.id, matchedCategory ?? undefined);
          await sendTextMessage(from, reply);
          return;
        }
        disambiguationByUserId.set(user.id, { transactionIds: [byContext.id], intent: null, createdAt: Date.now() });
        console.log(`WhatsApp: swipe-reply a REJECTED sin intención clara -> ${byContext.id}, preguntando si anotar.`);
        await sendTextMessage(from, buildAlreadyRejectedPrompt(byContext));
        return;
      }

      // AUTO_CONFIRMED u otro status: no hay una acción obvia definida todavía, no asumimos.
      console.log(`WhatsApp: swipe-reply a transacción ${byContext.id} con status ${byContext.status}, sin manejo específico.`);
    } else {
      contextIdFailedToResolve = true;
      console.log(`WhatsApp: llegó context.id (${contextMessageId}) pero no coincide con ninguna transacción; sigue el flujo normal.`);
    }
  }

  // 0.5) Intención de ELIMINAR un gasto ya CONFIRMED — también es una
  // intención nueva y deliberada, así que se resuelve antes de tocar
  // cualquier estado de desambiguación viejo que pudiera haber quedado
  // colgado de otra conversación.
  if (detectDeleteConfirmedIntent(normalized)) {
    console.log(`WhatsApp: intención de ELIMINAR un gasto confirmado, de ${from}.`);
    const deleteQuery = extractDetailQuery(normalized);
    const deleteMatches = await findTransactionsByDetails(user.id, deleteQuery, "CONFIRMED");

    if (deleteMatches.length === 0) {
      await sendTextMessage(from, "No encontré ningún gasto confirmado que coincida con esos detalles.");
      return;
    }

    if (deleteMatches.length === 1) {
      const target = deleteMatches[0];
      disambiguationByUserId.set(user.id, {
        transactionIds: [target.id],
        intent: { action: "delete" },
        createdAt: Date.now(),
      });
      console.log(`WhatsApp: match único para ELIMINAR -> transacción ${target.id}, pidiendo confirmación explícita.`);
      await sendTextMessage(from, buildDeleteConfirmPrompt(target));
      return;
    }

    disambiguationByUserId.set(user.id, {
      transactionIds: deleteMatches.map((m) => m.id),
      intent: { action: "delete" },
      createdAt: Date.now(),
    });
    console.log(`WhatsApp: búsqueda para ELIMINAR dio ${deleteMatches.length} resultados ambiguos.`);
    await sendTextMessage(from, buildDisambiguationMessage(deleteMatches));
    return;
  }

  // 0.55) Intención de RECATEGORIZAR un gasto ya CONFIRMED, identificado
  // por detalles (ej. "cambia el gasto de Oscar Saavedra a Yape/Plin").
  // Antes NO existía ningún camino para esto — un gasto ya confirmado no
  // aparece en la búsqueda de PENDING_CONFIRMATION (paso 1 de abajo), así
  // que este tipo de mensaje caía derecho al fallback final y terminaba
  // "confirmando" ciegamente la pendiente más reciente (bug real: "cambia
  // el gasto de Oscar Saavedra a Yape/Plin" terminó confirmando "Olga
  // Huaman", sin relación alguna). No es destructivo (no pierde datos como
  // eliminar), así que un match único se aplica directo.
  if (detectRecategorizeIntent(normalized)) {
    console.log(`WhatsApp: intención de RECATEGORIZAR un gasto confirmado, de ${from}.`);
    const categories = await getCategories(user.id);
    const targetCategory = resolveRuleTargetCategory(normalized, categories);

    if (!targetCategory) {
      await sendTextMessage(
        from,
        'No entendí a qué categoría quieres moverlo. Decime algo como "cambia el gasto de Burger King a Alimentación".'
      );
      return;
    }

    const identificationText = extractRecategorizeIdentificationText(normalized);
    const recategorizeQuery = extractDetailQuery(identificationText);
    const recategorizeMatches = await findTransactionsByDetails(user.id, recategorizeQuery, "CONFIRMED");

    if (recategorizeMatches.length === 0) {
      await sendTextMessage(from, "No encontré ningún gasto confirmado que coincida con esos detalles.");
      return;
    }

    if (recategorizeMatches.length === 1) {
      console.log(`WhatsApp: match único para RECATEGORIZAR -> transacción ${recategorizeMatches[0].id} -> ${targetCategory.name}`);
      await recategorizeConfirmedTransaction(recategorizeMatches[0], user.id, from, targetCategory);
      return;
    }

    disambiguationByUserId.set(user.id, {
      transactionIds: recategorizeMatches.map((m) => m.id),
      intent: { action: "recategorize", category: targetCategory },
      createdAt: Date.now(),
    });
    console.log(`WhatsApp: búsqueda para RECATEGORIZAR dio ${recategorizeMatches.length} resultados ambiguos.`);
    await sendTextMessage(from, buildDisambiguationMessage(recategorizeMatches));
    return;
  }

  // 1) Búsqueda por detalles (monto/nombre/fecha) entre las PENDING_CONFIRMATION.
  const detailQuery = extractDetailQuery(normalized);
  const matches = await findTransactionsByDetails(user.id, detailQuery, "PENDING_CONFIRMATION");

  if (matches.length === 1) {
    const pending = matches[0];

    if (detectRejectIntent(normalized)) {
      console.log(`WhatsApp: match por DETALLES + intención RECHAZAR -> transacción ${pending.id}`);
      await applyResolvedIntent(pending, user.id, from, { action: "reject" });
      return;
    }

    if (hasStrongDetailSignal(detailQuery)) {
      const categories = await getCategories(user.id);
      const matchedCategory = resolveCategoryFromText(normalized, categories);
      console.log(
        `WhatsApp: match por DETALLES + intención CONFIRMAR (monto/fecha específicos, por defecto) -> transacción ${pending.id}`
      );
      await applyResolvedIntent(pending, user.id, from, { action: "confirm", category: matchedCategory ?? undefined });
      return;
    }

    // Solo un nombre suelto, sin verbo ni monto/fecha: no asumimos, pedimos confirmación explícita.
    console.log(`WhatsApp: match por DETALLES (solo nombre) -> transacción ${pending.id}, pidiendo confirmación explícita.`);
    disambiguationByUserId.set(user.id, { transactionIds: [pending.id], intent: null, createdAt: Date.now() });
    await sendTextMessage(from, buildConfirmPrompt(pending));
    return;
  }

  if (matches.length > 1) {
    const isReject = detectRejectIntent(normalized);
    let intent: ResolvedIntent | null = null;
    if (isReject) {
      intent = { action: "reject" };
    } else if (hasStrongDetailSignal(detailQuery)) {
      const categories = await getCategories(user.id);
      const matchedCategory = resolveCategoryFromText(normalized, categories);
      intent = { action: "confirm", category: matchedCategory ?? undefined };
    }

    disambiguationByUserId.set(user.id, { transactionIds: matches.map((m) => m.id), intent, createdAt: Date.now() });
    console.log(
      `WhatsApp: búsqueda por detalles dio ${matches.length} resultados ambiguos ` +
        `(intención detectada: ${intent?.action ?? "ninguna"}), pidiendo aclaración.`
    );
    await sendTextMessage(from, buildDisambiguationMessage(matches));
    return;
  }

  // 1.5) Nada pendiente coincidió, pero el mensaje suena a "sí, anótalo" con
  // detalles (monto/nombre/fecha): puede que se refiera a restaurar un gasto
  // CONFIRMED que ya está eliminado, para cuando el usuario no tiene a mano
  // el mensaje original para hacer swipe-reply.
  if (detectConfirmIntent(normalized)) {
    const deletedMatches = await findTransactionsByDetails(user.id, detailQuery, "CONFIRMED", { onlyDeleted: true });

    if (deletedMatches.length === 1) {
      const categories = await getCategories(user.id);
      const matchedCategory = resolveCategoryFromText(normalized, categories);
      console.log(`WhatsApp: match por DETALLES entre eliminados + intención RESTAURAR -> ${deletedMatches[0].id}`);
      await applyResolvedIntent(deletedMatches[0], user.id, from, { action: "restore", category: matchedCategory ?? undefined });
      return;
    }
    if (deletedMatches.length > 1) {
      const categories = await getCategories(user.id);
      const matchedCategory = resolveCategoryFromText(normalized, categories);
      disambiguationByUserId.set(user.id, {
        transactionIds: deletedMatches.map((m) => m.id),
        intent: { action: "restore", category: matchedCategory ?? undefined },
        createdAt: Date.now(),
      });
      console.log(`WhatsApp: búsqueda entre eliminados dio ${deletedMatches.length} resultados ambiguos, pidiendo aclaración.`);
      await sendTextMessage(from, buildDisambiguationMessage(deletedMatches));
      return;
    }
    // 0 resultados entre eliminados: seguimos al flujo normal.
  }

  // 2) Sin match por detalles ni por restauración: fallback a la
  // PENDING_CONFIRMATION más reciente — PERO solo si el mensaje llegó sin
  // ningún context.id, o sea, sin ninguna señal de que el usuario quiso
  // responder a una transacción puntual. Si SÍ llegó un context.id y no
  // resolvió a nada (contextIdFailedToResolve, ver 0.4), asumir "la más
  // reciente" es adivinar a ciegas — puede ser cualquier otra transacción
  // sin relación (bug real: así se confirmó "Olga Huaman" en vez de "Oscar
  // Saavedra C", solo porque createdAt le ganaba por 7 segundos). En ese
  // caso se pide aclarar en vez de asumir.
  if (contextIdFailedToResolve) {
    console.log("WhatsApp: context.id no resolvió a ninguna transacción y no hay más pistas en el texto — se pide aclarar en vez de adivinar.");
    await sendTextMessage(
      from,
      "No logré identificar a qué movimiento te referías (puede que la notificación original ya sea muy antigua). " +
        "¿Me dices el monto o el comercio para encontrarlo?"
    );
    return;
  }

  const allPendingForFallback = await prisma.transaction.findMany({
    where: { userId: user.id, status: "PENDING_CONFIRMATION" },
    orderBy: { createdAt: "desc" },
    include: { category: true },
  });

  if (allPendingForFallback.length === 0) {
    await sendTextMessage(from, "No tienes ninguna transacción pendiente de confirmar por ahora.");
    return;
  }

  if (allPendingForFallback.length === 1) {
    // Con una sola pendiente no hay nada que adivinar: cualquier señal en
    // el texto (sí/no/categoría mencionada) solo puede referirse a ESA.
    console.log(`WhatsApp: FALLBACK (sin context.id ni detalles útiles) -> única pendiente ${allPendingForFallback[0].id}`);
    await handleFreeformDecision(allPendingForFallback[0], user.id, from, normalized);
    return;
  }

  // Hay VARIAS pendientes y ninguna otra señal (comercio/monto/fecha/
  // categoría con nombre) las distinguió: acá sí sería adivinar a ciegas
  // cuál de todas quiso decir el usuario. Por eso este último recurso solo
  // actúa cuando el mensaje es EXACTAMENTE una confirmación simple ("sí"),
  // que es el caso ya establecido de tocar el botón/notificación más
  // reciente sin más contexto — cualquier otra cosa (nombres mal escritos,
  // categorías sueltas, texto random) pide aclaración en vez de asumir.
  // Bug real que esto corrige: "cambia el gasto de Oscar Saavedra a
  // Yape/Plin" (con Oscar ya CONFIRMED, fuera del pool de pendientes)
  // terminaba "confirmando" a ciegas otra pendiente no relacionada, solo
  // porque el texto mencionaba una categoría real.
  if (!CONFIRM_WORDS.has(normalized)) {
    console.log(`WhatsApp: FALLBACK con ${allPendingForFallback.length} pendientes y mensaje no reconocido ("${normalized}") — se pide aclarar en vez de adivinar.`);
    await sendTextMessage(
      from,
      "No logré identificar a qué movimiento te referías. ¿Me dices el monto o el nombre del comercio para encontrarlo?"
    );
    return;
  }

  const mostRecentPending = allPendingForFallback[0];
  console.log(`WhatsApp: FALLBACK (confirmación simple, varias pendientes) -> se usa la más reciente ${mostRecentPending.id}`);
  await handleFreeformDecision(mostRecentPending, user.id, from, normalized);
}

/**
 * Fase 4: el usuario reenvió por WhatsApp una captura de pantalla de una
 * transferencia/Yape/Plin. La lee con Gemini Vision y, si es una captura
 * válida, guarda lo extraído en pendingImageByUserId y pregunta siempre con
 * botones si es GASTO/TRASPASO/INGRESO — nunca se lo pedimos adivinar a
 * Gemini, porque una captura de transferencia es ambigua por naturaleza
 * (puede ser a un tercero o entre cuentas propias del mismo usuario). Se
 * llama desde POST /webhook cuando message.type === "image".
 */
export async function handleIncomingImage(from: string, mediaId: string): Promise<void> {
  const user = await findUserByWhatsappNumber(from);
  if (!user) {
    console.log(`WhatsApp: imagen de un número no registrado (${from}), se ignora.`);
    return;
  }

  const media = await downloadWhatsappMedia(mediaId);
  if (!media) {
    await sendTextMessage(from, "No pude descargar la imagen que enviaste. ¿Puedes intentar reenviarla?");
    return;
  }

  const categories = await getCategories(user.id);
  const categoryNames = categories.map((c) => c.name);

  let extracted;
  try {
    extracted = await extractTransferFromImage(media.base64, media.mimeType, categoryNames);
  } catch (err) {
    console.error("Error leyendo la captura con Gemini Vision:", err);
    await sendTextMessage(from, "No pude leer los datos de esa imagen. ¿Puedes intentar con otra captura, o contarme el movimiento por texto?");
    return;
  }

  if (!extracted.isTransferScreenshot || !extracted.amount) {
    await sendTextMessage(from, "No reconocí esa imagen como una captura de transferencia — si me equivoco, cuéntame el movimiento por texto.");
    return;
  }

  pendingImageByUserId.set(user.id, {
    amount: extracted.amount,
    currency: extracted.currency ?? "PEN",
    recipient: extracted.recipient,
    bankOrWallet: extracted.bankOrWallet,
    fee: extracted.fee,
    occurredAt: extracted.occurredAt ? new Date(extracted.occurredAt) : new Date(),
    operationNumber: extracted.operationNumber,
    suggestedCategory: extracted.suggestedCategory,
    createdAt: Date.now(),
  });

  const who = extracted.recipient ? ` a ${extracted.recipient}` : "";
  const bank = extracted.bankOrWallet ? ` (${extracted.bankOrWallet})` : "";
  const amountLine = `${extracted.currency ?? "PEN"} ${extracted.amount.toFixed(2)}`;

  console.log(`WhatsApp: captura leída de ${from} -> ${amountLine}${who}${bank}, preguntando tipo de movimiento.`);

  await sendInteractiveButtons(from, `📸 Leí la captura: ${amountLine}${who}${bank}. ¿Qué tipo de movimiento es?`, [
    { id: BUTTON_ID_IMAGE_EXPENSE, title: "💸 Gasto" },
    { id: BUTTON_ID_IMAGE_TRANSFER, title: "🔄 Traspaso propio" },
    { id: BUTTON_ID_IMAGE_INCOME, title: "💰 Ingreso" },
  ]);
}

/**
 * Se llama justo después de crear una transacción PENDING_CONFIRMATION
 * (ver src/services/outlookSync.ts), para preguntarle al usuario si la
 * anotamos, con dos botones para responder en un toque. Si el usuario no
 * tiene un número de WhatsApp vinculado, no manda nada (caso normal).
 */
export async function notifyPendingTransaction(
  transaction: Transaction & { category?: { name: string } | null },
  phoneNumber: string | null | undefined
): Promise<void> {
  if (!phoneNumber) return;

  const messageId = await sendInteractiveButtons(phoneNumber, buildNotificationBody(transaction), [
    { id: BUTTON_ID_CONFIRM, title: "✅ Anotar" },
    { id: BUTTON_ID_REJECT, title: "🗑️ Descartar" },
  ]);

  if (messageId) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { lastNotificationMessageId: messageId },
    });
  }
}

/**
 * Traduce el id de un botón interactivo al texto equivalente que ya
 * entiende handleIncomingMessage, para no duplicar la lógica de
 * confirmar/rechazar.
 */
export function textForButtonReply(buttonId: string): string | null {
  if (buttonId === BUTTON_ID_CONFIRM) return "confirmar";
  if (buttonId === BUTTON_ID_REJECT) return "no";
  if (buttonId === BUTTON_ID_IMAGE_EXPENSE) return "gasto";
  if (buttonId === BUTTON_ID_IMAGE_TRANSFER) return "traspaso";
  if (buttonId === BUTTON_ID_IMAGE_INCOME) return "ingreso";
  return null;
}
