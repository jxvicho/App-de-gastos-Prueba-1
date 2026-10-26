import express, { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { limaDayStart } from "../services/plans";
import { WEB_CHAT_HARD_CAP_PER_USER } from "../config/plans";
import { handleWebMessage, handleWebMedia, textForButtonReply } from "../services/whatsappBot";

/**
 * Chat web del dashboard. Reutiliza handleIncomingMessage (la misma lógica del
 * bot de WhatsApp); las respuestas se capturan y se devuelven al navegador.
 * El historial se guarda en WhatsappMessage con channel = "WEB".
 */
export const chatRouter = Router();
chatRouter.use(requireAuth);

const MAX_TEXT = 1000;
/** Tope diario del chat web: fijo en código (no depende del .env), igual para todos los planes. */
const WEB_DAILY_CAP = WEB_CHAT_HARD_CAP_PER_USER;

function requireEnabled() {
  if (!env.WEB_CHAT_ENABLED) throw new AppError("El chat web no está habilitado", 404);
}

async function getSession(userId: string) {
  return prisma.whatsappSession.upsert({
    where: { userId },
    update: {},
    create: { userId, waPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "web" },
  });
}

function serialize(m: any) {
  return {
    id: m.id,
    role: m.direction === "INBOUND" ? "user" : "bot",
    text: m.content,
    buttons: m.buttons ?? undefined,
    channel: m.channel,
    createdAt: m.createdAt,
  };
}

async function usedToday(sessionId: string) {
  return prisma.whatsappMessage.count({
    where: { sessionId, channel: "WEB", direction: "INBOUND", createdAt: { gte: limaDayStart() } },
  });
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"];

chatRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    res.json({ enabled: env.WEB_CHAT_ENABLED, dailyCap: WEB_DAILY_CAP, media: true });
  })
);

chatRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    requireEnabled();
    const session = await getSession(req.userId!);
    // ?since=ISO -> solo mensajes del bot posteriores (polling de avisos nuevos, sin repetir los propios).
    const sinceRaw = typeof req.query.since === "string" ? new Date(req.query.since) : null;
    if (sinceRaw && !isNaN(sinceRaw.getTime())) {
      const fresh = await prisma.whatsappMessage.findMany({
        where: { sessionId: session.id, direction: "OUTBOUND", createdAt: { gt: sinceRaw } },
        orderBy: { createdAt: "asc" },
        take: 30,
      });
      res.json({ messages: fresh.map(serialize) });
      return;
    }
    const rows = await prisma.whatsappMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    const used = await usedToday(session.id);
    res.json({ messages: rows.reverse().map(serialize), remainingToday: Math.max(0, WEB_DAILY_CAP - used) });
  })
);

const sendSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_TEXT).optional(),
    buttonId: z.string().max(100).optional(),
    // "Responder a" un movimiento concreto (equivale al "responder" de WhatsApp sobre su aviso).
    replyToTxnId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  })
  .refine((v) => v.text || v.buttonId, { message: "Escribe un mensaje" });

chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    requireEnabled();
    const body = sendSchema.parse(req.body);
    // Un clic en botón equivale al mismo texto que entiende el bot de WhatsApp.
    // "web_del:<id>" = botón 🗑️ bajo un movimiento registrado (equivale a responder "eliminar" a ese mensaje en WhatsApp).
    // "web_ok:<id>" / "web_no:<id>" = Anotar / Descartar un movimiento detectado (como los botones de WhatsApp).
    const txMatch = body.buttonId?.match(/^web_(del|ok|no):([\w-]{1,64})$/);
    const text = txMatch
      ? { del: "eliminar", ok: "confirmar", no: "no" }[txMatch[1] as "del" | "ok" | "no"]
      : body.buttonId
        ? textForButtonReply(body.buttonId)
        : body.text;
    const contextId = txMatch
      ? `web:txn:${txMatch[2]}`
      : body.replyToTxnId && body.text
        ? `web:txn:${body.replyToTxnId}`
        : null;
    if (!text) throw new AppError("Botón no reconocido", 400);
    const userId = req.userId!;
    const session = await getSession(userId);

    const used = await usedToday(session.id);
    if (used >= WEB_DAILY_CAP) {
      throw new AppError("Llegaste al límite de mensajes del chat por hoy. Mañana podrás seguir.", 429);
    }

    await prisma.whatsappMessage.create({
      data: { sessionId: session.id, direction: "INBOUND", content: text, channel: "WEB" },
    });

    let replies;
    try {
      replies = await handleWebMessage(userId, text, contextId);
    } catch (err) {
      console.error("Chat web: error procesando el mensaje:", err);
      replies = [{ text: "Tuve un problema procesando tu mensaje. Inténtalo de nuevo en un momento." }];
    }

    const saved = [];
    for (const r of replies) {
      saved.push(
        await prisma.whatsappMessage.create({
          data: {
            sessionId: session.id,
            direction: "OUTBOUND",
            content: r.text,
            channel: "WEB",
            buttons: r.buttons ? (r.buttons as any) : undefined,
          },
        })
      );
    }
    await prisma.whatsappSession.update({ where: { id: session.id }, data: { lastMessageAt: new Date() } });

    res.json({ replies: saved.map(serialize), remainingToday: Math.max(0, WEB_DAILY_CAP - used - 1) });
  })
);

// Imagen o nota de voz: el navegador manda el archivo crudo (Content-Type = su mime).
chatRouter.post(
  "/media",
  express.raw({ type: ["image/*", "audio/*"], limit: "6mb" }),
  asyncHandler(async (req, res) => {
    requireEnabled();
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const isImage = IMAGE_TYPES.includes(mime);
    const isAudio = AUDIO_TYPES.includes(mime);
    if (!isImage && !isAudio) throw new AppError("Tipo de archivo no permitido (imagen JPG/PNG/WebP o nota de voz)", 415);
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new AppError("Archivo vacío", 400);
    if (buf.length > (isImage ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)) {
      throw new AppError(isImage ? "La imagen supera 5 MB" : "La nota de voz es muy larga (máx. ~2 MB)", 413);
    }

    const userId = req.userId!;
    const session = await getSession(userId);
    const used = await usedToday(session.id);
    if (used >= WEB_DAILY_CAP) {
      throw new AppError("Llegaste al límite de mensajes del chat por hoy. Mañana podrás seguir.", 429);
    }

    await prisma.whatsappMessage.create({
      data: { sessionId: session.id, direction: "INBOUND", content: isImage ? "📷 Imagen enviada" : "🎤 Nota de voz", channel: "WEB" },
    });

    let replies;
    try {
      replies = await handleWebMedia(userId, isImage ? "image" : "audio", { base64: buf.toString("base64"), mimeType: mime });
    } catch (err) {
      console.error("Chat web: error procesando el archivo:", err);
      replies = [{ text: "Tuve un problema procesando el archivo. Inténtalo de nuevo en un momento." }];
    }

    const saved = [];
    for (const r of replies) {
      saved.push(
        await prisma.whatsappMessage.create({
          data: { sessionId: session.id, direction: "OUTBOUND", content: r.text, channel: "WEB", buttons: r.buttons ? (r.buttons as any) : undefined },
        })
      );
    }
    await prisma.whatsappSession.update({ where: { id: session.id }, data: { lastMessageAt: new Date() } });
    res.json({ replies: saved.map(serialize), remainingToday: Math.max(0, WEB_DAILY_CAP - used - 1) });
  })
);
