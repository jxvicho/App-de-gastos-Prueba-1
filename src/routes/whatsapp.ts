import { Router, Request } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { handleIncomingMessage, handleIncomingImage, handleIncomingAudio, textForButtonReply } from "../services/whatsappBot";
import { redisConnection } from "../queues/redisConnection";

// Cuánto tiempo recordamos un wamid ya procesado, para descartar reintentos
// de entrega de Meta sin volver a responder. 3 días es generoso frente a lo
// que Meta reintenta en la práctica (minutos/horas), sin crecer sin límite.
const PROCESSED_MESSAGE_TTL_SECONDS = 60 * 60 * 24 * 3;

/**
 * Marca un wamid como procesado de forma atómica (SET NX). Devuelve true si
 * es la primera vez que lo vemos (hay que procesarlo), false si ya se había
 * procesado antes (es un reintento de Meta, se descarta).
 *
 * Esto existe porque sin esto cada reintento de webhook de Meta (p. ej. tras
 * una cuenta reactivada con mensajes en cola) generaba una respuesta
 * duplicada del bot por cada entrega del mismo mensaje — y una ráfaga de
 * varias respuestas idénticas al mismo usuario es exactamente el patrón que
 * los sistemas antiabuso de WhatsApp detectan como spam, lo que a su vez
 * puede volver a inhabilitar la cuenta.
 */
async function markMessageAsProcessed(messageId: string): Promise<boolean> {
  const key = `wa:processed-msg:${messageId}`;
  const result = await redisConnection.set(key, "1", "EX", PROCESSED_MESSAGE_TTL_SECONDS, "NX");
  return result === "OK";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const whatsappRouter = Router();

whatsappRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

function hasValidSignature(req: Request): boolean {
  const signature = req.headers["x-hub-signature-256"];

  if (typeof signature !== "string") {
    console.warn("WhatsApp webhook: falta el header x-hub-signature-256, se rechaza la petición.");
    return false;
  }
  if (!req.rawBody) {
    console.warn("WhatsApp webhook: no se capturó rawBody (revisa el middleware express.json), se rechaza la petición.");
    return false;
  }
  if (!env.WHATSAPP_APP_SECRET) {
    console.warn("WhatsApp webhook: WHATSAPP_APP_SECRET no está configurado, se rechaza la petición.");
    return false;
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(req.rawBody).digest("hex");

  const received = Buffer.from(signature);
  const computed = Buffer.from(expected);

  if (received.length !== computed.length) {
    console.warn(
      `WhatsApp webhook: la firma recibida tiene una longitud distinta a la esperada ` +
        `(recibida: ${received.length} bytes, esperada: ${computed.length} bytes). ` +
        `Recibida (primeros 12 caracteres): ${signature.slice(0, 12)}…`
    );
    return false;
  }

  const valid = crypto.timingSafeEqual(received, computed);
  if (!valid) {
    console.warn(
      `WhatsApp webhook: la firma no coincidió con la esperada. ` +
        `Recibida: ${signature.slice(0, 12)}… / Esperada: ${expected.slice(0, 12)}… ` +
        `(revisa que WHATSAPP_APP_SECRET coincida exactamente con el configurado en Meta).`
    );
  }
  return valid;
}

whatsappRouter.post("/webhook", (req, res) => {
  console.log(`📬 WhatsApp webhook: petición POST recibida (${new Date().toISOString()})`);

  if (!hasValidSignature(req)) {
    res.sendStatus(403);
    return;
  }

  // Meta espera un 200 rápido; el procesamiento real va después, sin bloquear la respuesta.
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const messages = change?.value?.messages as unknown[] | undefined;
      if (!messages?.length) return;

      for (const message of messages as any[]) {
        const from = message.from;

        // Deduplicación por wamid: si Meta reintenta la entrega de este
        // mismo mensaje (reintentos normales, o un lote reenviado tras
        // reactivar la cuenta), lo descartamos en vez de volver a
        // responder. Si por algún motivo el mensaje no trae "id", preferimos
        // procesarlo (mejor una posible duplicación rara que perder mensajes).
        const messageId: string | undefined = message.id;
        if (messageId) {
          const isFirstTime = await markMessageAsProcessed(messageId);
          if (!isFirstTime) {
            console.log(`WhatsApp: mensaje ${messageId} ya fue procesado antes (reintento de Meta), se omite.`);
            continue;
          }
        } else {
          console.warn("WhatsApp webhook: mensaje sin \"id\", no se puede deduplicar — se procesa igual.");
        }

        // El "context.id" (cuando viene) es el wamid del mensaje al que el
        // usuario está respondiendo — nos deja identificar la transacción
        // exacta en vez de asumir "la más reciente pendiente".
        const contextMessageId: string | undefined = message.context?.id;

        if (message.type === "text") {
          const text = message.text?.body;
          console.log(`📩 WhatsApp de ${from}: ${text}${contextMessageId ? ` (context.id: ${contextMessageId})` : ""}`);
          if (typeof text === "string") {
            await handleIncomingMessage(from, text, contextMessageId);
          }
          continue;
        }

        if (message.type === "interactive" && message.interactive?.type === "button_reply") {
          const buttonId = message.interactive.button_reply?.id;
          console.log(
            `📩 WhatsApp de ${from}: botón "${message.interactive.button_reply?.title}" (${buttonId})${contextMessageId ? ` (context.id: ${contextMessageId})` : ""}`
          );
          const equivalentText = buttonId ? textForButtonReply(buttonId) : null;
          if (equivalentText) {
            await handleIncomingMessage(from, equivalentText, contextMessageId);
          }
          continue;
        }

        if (message.type === "image") {
          const mediaId: string | undefined = message.image?.id;
          console.log(`📩 WhatsApp de ${from}: imagen recibida (media id: ${mediaId ?? "desconocido"})`);
          if (mediaId) {
            await handleIncomingImage(from, mediaId);
          }
          continue;
        }

        if (message.type === "audio") {
          const mediaId: string | undefined = message.audio?.id;
          console.log(
            `📩 WhatsApp de ${from}: nota de voz recibida (media id: ${mediaId ?? "desconocido"})${contextMessageId ? ` (context.id: ${contextMessageId})` : ""}`
          );
          if (mediaId) {
            await handleIncomingAudio(from, mediaId, contextMessageId);
          }
          continue;
        }

        console.log(`📩 WhatsApp de ${from}: (mensaje sin manejar, tipo: ${message.type})`);
      }
    } catch (err) {
      console.error("Error procesando el webhook de WhatsApp:", err);
    }
  });
});
