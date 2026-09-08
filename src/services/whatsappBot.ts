import type { Transaction } from "@prisma/client";
import { prisma } from "../config/prisma";
import { sendInteractiveButtons, sendTextMessage } from "./whatsapp";
import { DEFAULT_CATEGORIES } from "../utils/defaultCategories";

const CONFIRM_WORDS = new Set(["si", "s", "yes", "confirmar"]);
const REJECT_WORDS = new Set(["no", "n"]);

const BUTTON_ID_CONFIRM = "txn_confirm";
const BUTTON_ID_REJECT = "txn_reject";

// Mapeamos por nombre de categoría para no reinventar íconos que ya
// existen en el catálogo real de categorías (DEFAULT_CATEGORIES).
const CATEGORY_ICON_BY_NAME = new Map(DEFAULT_CATEGORIES.map((c) => [c.name, c.icon]));
const FALLBACK_CATEGORY_ICON = "🏷️";

const MONTH_NAMES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

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

/**
 * Procesa la respuesta de un usuario a la pregunta "¿Lo anotamos?" mandada
 * por notifyPendingTransaction — ya sea texto libre ("sí"/"no") o el click
 * en uno de los botones interactivos. Se llama desde POST /webhook.
 */
export async function handleIncomingMessage(from: string, text: string): Promise<void> {
  const user = await findUserByWhatsappNumber(from);
  if (!user) {
    console.log(`WhatsApp: mensaje de un número no registrado (${from}), se ignora.`);
    return;
  }

  const pending = await prisma.transaction.findFirst({
    where: { userId: user.id, status: "PENDING_CONFIRMATION" },
    orderBy: { createdAt: "desc" },
    include: { category: true },
  });

  if (!pending) {
    await sendTextMessage(from, "No tienes ninguna transacción pendiente de confirmar por ahora.");
    return;
  }

  const normalized = normalizeText(text);

  if (CONFIRM_WORDS.has(normalized)) {
    await prisma.transaction.update({
      where: { id: pending.id },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });

    const who = pending.merchant || pending.description || "el movimiento";
    let reply = `✅ *Anotado:* ${formatAmount(pending)} en ${who}.`;

    if (pending.categoryId) {
      const monthTotal = await sumConfirmedThisMonth(user.id, pending.categoryId);
      if (monthTotal !== null) {
        reply += `\nLlevas ${pending.currency} ${monthTotal.toFixed(2)} en ${pending.category?.name} este mes.`;
      }
    }

    await sendTextMessage(from, reply);
    return;
  }

  if (REJECT_WORDS.has(normalized)) {
    await prisma.transaction.update({
      where: { id: pending.id },
      data: { status: "REJECTED" },
    });
    await sendTextMessage(from, "Entendido, no lo anotamos. 👍");
    return;
  }

  await sendTextMessage(
    from,
    "No entendí tu respuesta. Usa los botones o responde *Sí* o *No* para confirmar o descartar tu último movimiento."
  );
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
      occurredAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });

  return result._sum.amount ? Number(result._sum.amount) : null;
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

  await sendInteractiveButtons(phoneNumber, buildNotificationBody(transaction), [
    { id: BUTTON_ID_CONFIRM, title: "✅ Anotar" },
    { id: BUTTON_ID_REJECT, title: "🗑️ Descartar" },
  ]);
}

/**
 * Traduce el id de un botón interactivo al texto equivalente que ya
 * entiende handleIncomingMessage, para no duplicar la lógica de
 * confirmar/rechazar.
 */
export function textForButtonReply(buttonId: string): string | null {
  if (buttonId === BUTTON_ID_CONFIRM) return "confirmar";
  if (buttonId === BUTTON_ID_REJECT) return "no";
  return null;
}
