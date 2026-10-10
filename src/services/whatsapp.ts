import crypto from "crypto";
import { env } from "../config/env";
import { redisConnection } from "../queues/redisConnection";
import { prisma } from "../config/prisma";
import { DAILY_HARD_CAP_PER_USER } from "../config/plans";
import { getEffectivePlan, limaDayStart, limaMonthStart } from "./plans";

const GRAPH_BASE_URL = "https://graph.facebook.com";

/**
 * Evita mandar el MISMO texto al MISMO número más de una vez en una ventana
 * corta. Esto es distinto del dedup por wamid del webhook (ese descarta
 * reintentos de ENTREGA de un mensaje ENTRANTE que Meta repite). Este cubre
 * el caso real que causó las deshabilitaciones de la cuenta: el usuario
 * reenvía varios mensajes que el bot no reconoce en rápida sucesión (ej.
 * "Hola", "Hola", "Hola" en menos de 1 segundo) y, sin este control, el bot
 * contestaba la MISMA respuesta de fallback una y otra vez — una ráfaga de
 * mensajes salientes casi idénticos al mismo usuario es justo el patrón que
 * los sistemas antiabuso de WhatsApp detectan como spam.
 */
const OUTBOUND_DEDUP_WINDOW_SECONDS = 8;

async function shouldSuppressDuplicateOutbound(to: string, fingerprint: string): Promise<boolean> {
  try {
    const hash = crypto.createHash("sha1").update(fingerprint).digest("hex");
    const key = `wa:out-dedup:${to}:${hash}`;
    const result = await redisConnection.set(key, "1", "EX", OUTBOUND_DEDUP_WINDOW_SECONDS, "NX");
    return result !== "OK"; // true = este mismo texto ya se mandó hace menos de N segundos
  } catch (err) {
    // Si Redis falla, preferimos mandar el mensaje (mejor una posible
    // duplicación rara que dejar al usuario sin respuesta) en vez de
    // bloquear todo el envío de WhatsApp por un problema de Redis.
    console.error("No se pudo verificar el dedup de mensajes salientes de WhatsApp:", err);
    return false;
  }
}

interface GraphSendResponse {
  messages?: { id: string }[];
}

function messagesUrl(): string {
  return `${GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

function mediaUploadUrl(): string {
  return `${GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`;
}

async function postToGraph(payload: Record<string, unknown>): Promise<GraphSendResponse> {
  const res = await fetch(messagesUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`Error de la API de WhatsApp (${res.status}):`, errorBody);
    throw new Error(`WhatsApp API respondió ${res.status}`);
  }

  return (await res.json()) as GraphSendResponse;
}

/* =========================================================
   CAPA CENTRAL DE ENVÍO
   Todo mensaje saliente pasa por authorizeSend (ventana de 24 h,
   tope mensual del plan, tope diario duro) y queda registrado en
   OutboundMessage. El dedup de 8 s se mantiene en cada función de envío.
   ========================================================= */

/** Tipos de mensaje saliente. Solo "reply" cuenta para el tope mensual del plan. */
export type OutboundKind = "reply" | "txn_notification" | "alert" | "daily_summary" | "weekly_report" | "limit_notice";
export interface SendOpts {
  kind?: OutboundKind;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

function phoneVariants(waId: string): string[] {
  const digits = waId.replace(/^\+/, "");
  return [`+${digits}`, digits];
}

async function findUserByWaId(waId: string) {
  return prisma.user.findFirst({
    where: { phoneNumber: { in: phoneVariants(waId) } },
    select: { id: true, plan: true, planOverride: true, planOverrideUntil: true, lastInboundAt: true },
  });
}

/** Se llama por cada mensaje ENTRANTE: renueva la ventana de 24 h del usuario (user.lastInboundAt). */
export async function markInboundWindow(waId: string): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { phoneNumber: { in: phoneVariants(waId) } },
      data: { lastInboundAt: new Date() },
    });
  } catch (err) {
    console.error("No se pudo actualizar lastInboundAt:", err);
  }
}

/** true si el usuario escribió en las últimas 24 h (se permite texto libre). */
export async function isWindowOpen(waId: string): Promise<boolean> {
  const user = await findUserByWaId(waId);
  return !!user?.lastInboundAt && Date.now() - user.lastInboundAt.getTime() < WINDOW_MS;
}

interface AuthResult {
  allowed: boolean;
  userId?: string;
}

async function authorizeSend(to: string, kind: OutboundKind, isTemplate: boolean): Promise<AuthResult> {
  try {
    const user = await findUserByWaId(to);
    // Número desconocido (ej. alguien aún sin cuenta que acaba de escribir): se permite, sin registro.
    if (!user) return { allowed: true };

    const now = new Date();

    if (!isTemplate) {
      const open = !!user.lastInboundAt && now.getTime() - user.lastInboundAt.getTime() < WINDOW_MS;
      if (!open) {
        console.log(`WhatsApp: no se envía ${kind} a ${to}: la ventana de 24 h está cerrada (solo se permiten plantillas).`);
        return { allowed: false, userId: user.id };
      }
    }

    const sentToday = await prisma.outboundMessage.count({
      where: { userId: user.id, createdAt: { gte: limaDayStart(now) } },
    });
    if (sentToday >= DAILY_HARD_CAP_PER_USER) {
      console.warn(`WhatsApp: tope diario de ${DAILY_HARD_CAP_PER_USER} mensajes alcanzado para el usuario ${user.id}; se omite ${kind}.`);
      return { allowed: false, userId: user.id };
    }

    if (kind === "reply") {
      const eff = await getEffectivePlan(user, now);
      if (eff.monthlyReplies !== null) {
        const used = await prisma.outboundMessage.count({
          where: { userId: user.id, kind: "reply", createdAt: { gte: limaMonthStart(now) } },
        });
        if (used >= eff.monthlyReplies) {
          console.log(`WhatsApp: tope mensual de respuestas (${eff.monthlyReplies}, plan ${eff.plan}) alcanzado para ${user.id}; se omite la respuesta.`);
          return { allowed: false, userId: user.id };
        }
      }
    }
    return { allowed: true, userId: user.id };
  } catch (err) {
    // Si la base falla no bloqueamos al usuario (mejor responder que quedar mudo).
    console.error("No se pudo evaluar el envío de WhatsApp (se permite):", err);
    return { allowed: true };
  }
}

async function recordOutbound(userId: string | undefined, wamid: string | undefined, kind: OutboundKind, isTemplate: boolean) {
  if (!userId || !wamid) return;
  try {
    await prisma.outboundMessage.upsert({
      where: { wamid },
      update: {},
      create: { userId, wamid, kind, isTemplate },
    });
  } catch (err) {
    console.error("No se pudo registrar el mensaje saliente:", err);
  }
}

/**
 * Manda un mensaje de texto libre. Solo funciona dentro de la ventana de
 * 24h de conversación abierta por el usuario (o en respuesta a un mensaje
 * suyo) — fuera de esa ventana, Meta requiere sendTemplateMessage.
 * Devuelve el wamid del mensaje enviado (o undefined si falló).
 */
export async function sendTextMessage(to: string, body: string, opts: SendOpts = {}): Promise<string | undefined> {
  const kind = opts.kind ?? "reply";
  if (await shouldSuppressDuplicateOutbound(to, body)) {
    console.log(
      `WhatsApp: se omite mensaje de texto repetido a ${to} (mismo texto enviado hace menos de ${OUTBOUND_DEDUP_WINDOW_SECONDS}s).`
    );
    return undefined;
  }
  const auth = await authorizeSend(to, kind, false);
  if (!auth.allowed) return undefined;
  try {
    const data = await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    });
    const wamid = data.messages?.[0]?.id;
    await recordOutbound(auth.userId, wamid, kind, false);
    return wamid;
  } catch (err) {
    console.error(`No se pudo enviar el mensaje de texto a ${to}:`, err);
    return undefined;
  }
}

/**
 * Manda un mensaje con hasta 3 botones de respuesta rápida ("reply
 * buttons"). Igual que sendTextMessage, solo funciona dentro de la
 * ventana de 24h. El título de cada botón debe tener 20 caracteres o menos
 * (límite de la Graph API). Devuelve el wamid del mensaje enviado (o
 * undefined si falló).
 */
export async function sendInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[],
  opts: SendOpts = {}
): Promise<string | undefined> {
  const kind = opts.kind ?? "reply";
  const fingerprint = bodyText + "|" + buttons.map((b) => b.id).join(",");
  if (await shouldSuppressDuplicateOutbound(to, fingerprint)) {
    console.log(
      `WhatsApp: se omiten botones repetidos a ${to} (mismo contenido enviado hace menos de ${OUTBOUND_DEDUP_WINDOW_SECONDS}s).`
    );
    return undefined;
  }
  const auth = await authorizeSend(to, kind, false);
  if (!auth.allowed) return undefined;
  try {
    const data = await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((button) => ({
            type: "reply",
            reply: { id: button.id, title: button.title },
          })),
        },
      },
    });
    const wamid = data.messages?.[0]?.id;
    await recordOutbound(auth.userId, wamid, kind, false);
    return wamid;
  } catch (err) {
    console.error(`No se pudieron enviar los botones a ${to}:`, err);
    return undefined;
  }
}

/**
 * Sube un binario a la Graph API (POST .../media, multipart/form-data) y
 * devuelve el media id que después se usa para mandarlo — subir y mandar
 * son dos pasos separados en la Cloud API, igual que descargar un media
 * entrante (ver whatsappMedia.ts) también son 2 pasos.
 */
async function uploadMedia(buffer: Buffer, mimeType: string): Promise<string | undefined> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([buffer], { type: mimeType }), "reporte.png");

  const res = await fetch(mediaUploadUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`Error subiendo media a la API de WhatsApp (${res.status}):`, errorBody);
    return undefined;
  }

  const data = (await res.json()) as { id?: string };
  return data.id;
}

/**
 * Manda una imagen (ej. el reporte semanal). Sube el buffer como media
 * primero, y con el id que devuelve manda el mensaje tipo "image". Devuelve
 * el wamid del mensaje enviado (o undefined si falló en cualquiera de los
 * 2 pasos).
 */
export async function sendImageMessage(
  to: string,
  imageBuffer: Buffer,
  caption?: string,
  opts: SendOpts = {}
): Promise<string | undefined> {
  const kind = opts.kind ?? "reply";
  const auth = await authorizeSend(to, kind, false);
  if (!auth.allowed) return undefined;
  try {
    const mediaId = await uploadMedia(imageBuffer, "image/png");
    if (!mediaId) {
      console.error(`No se pudo subir la imagen a WhatsApp para ${to} (sin media id).`);
      return undefined;
    }

    const data = await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { id: mediaId, ...(caption ? { caption } : {}) },
    });
    const wamid = data.messages?.[0]?.id;
    await recordOutbound(auth.userId, wamid, kind, false);
    return wamid;
  } catch (err) {
    console.error(`No se pudo enviar la imagen a ${to}:`, err);
    return undefined;
  }
}

/**
 * Meta rechaza variables con saltos de línea, tabs o 4+ espacios seguidos, y
 * no admite variables vacías. Esto las deja válidas.
 */
export function sanitizeTemplateParam(value: string): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > 0 ? clean.slice(0, 200) : "-";
}

function bodyComponent(bodyParams: string[]) {
  return {
    type: "body",
    parameters: bodyParams.map((text) => ({ type: "text", text: sanitizeTemplateParam(text) })),
  };
}

export interface TemplateOpts extends SendOpts {
  /** Parte variable de un botón CTA URL (lo que va al final de la URL base registrada en la plantilla). */
  urlButtonSuffix?: string;
}

function urlButtonComponent(suffix: string) {
  return { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: suffix }] };
}

/**
 * Manda un mensaje de tipo plantilla (template), el único tipo permitido
 * fuera de la ventana de 24 h. `bodyParams` son las variables {{1}}, {{2}}…
 * del cuerpo, en orden. Opcional: imagen en el encabezado y botón CTA URL.
 * Idioma por defecto: español. Devuelve el wamid (o undefined si falló).
 */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode = "es",
  bodyParams: string[] = [],
  opts: TemplateOpts & { headerImage?: Buffer } = {}
): Promise<string | undefined> {
  const kind = opts.kind ?? "daily_summary";
  const auth = await authorizeSend(to, kind, true);
  if (!auth.allowed) return undefined;
  try {
    const components: Record<string, unknown>[] = [];
    if (opts.headerImage) {
      const mediaId = await uploadMedia(opts.headerImage, "image/png");
      if (!mediaId) {
        console.error(`No se pudo subir la imagen a WhatsApp para ${to} (sin media id).`);
        return undefined;
      }
      components.push({ type: "header", parameters: [{ type: "image", image: { id: mediaId } }] });
    }
    if (bodyParams.length) components.push(bodyComponent(bodyParams));
    if (opts.urlButtonSuffix !== undefined) components.push(urlButtonComponent(opts.urlButtonSuffix));

    const data = await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    });
    const wamid = data.messages?.[0]?.id;
    await recordOutbound(auth.userId, wamid, kind, true);
    return wamid;
  } catch (err) {
    console.error(`No se pudo enviar la plantilla "${templateName}" a ${to}:`, err);
    return undefined;
  }
}

/** Plantilla con imagen en el encabezado (ej. el resumen) y variables en el cuerpo. */
export async function sendTemplateWithImage(
  to: string,
  templateName: string,
  languageCode: string,
  imageBuffer: Buffer,
  bodyParams: string[],
  opts: TemplateOpts = {}
): Promise<string | undefined> {
  return sendTemplateMessage(to, templateName, languageCode, bodyParams, { ...opts, headerImage: imageBuffer });
}
