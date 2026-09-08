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
  if (typeof signature !== "string" || !req.rawBody || !env.WHATSAPP_APP_SECRET) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(req.rawBody).digest("hex");

  const received = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (received.length !== computed.length) return false;

  return crypto.timingSafeEqual(received, computed);
}

whatsappRouter.post("/webhook", (req, res) => {
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

        if (message.type === "text") {
          const text = message.text?.body;
          console.log(`📩 WhatsApp de ${from}: ${text}`);
          if (typeof text === "string") {
            await handleIncomingMessage(from, text);
          }
          continue;
        }

        if (message.type === "interactive" && message.interactive?.type === "button_reply") {
          const buttonId = message.interactive.button_reply?.id;
          console.log(`📩 WhatsApp de ${from}: botón "${message.interactive.button_reply?.title}" (${buttonId})`);
          const equivalentText = buttonId ? textForButtonReply(buttonId) : null;
          if (equivalentText) {
            await handleIncomingMessage(from, equivalentText);
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
