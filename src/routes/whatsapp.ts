import { Router, Request } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { handleIncomingMessage, textForButtonReply } from "../services/whatsappBot";

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

        console.log(`📩 WhatsApp de ${from}: (mensaje sin manejar, tipo: ${message.type})`);
      }
    } catch (err) {
      console.error("Error procesando el webhook de WhatsApp:", err);
    }
  });
});
