import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { limaDayStart } from "../services/plans";
import { handleWebMessage, textForButtonReply } from "../services/whatsappBot";

/**
 * Chat web del dashboard. Reutiliza handleIncomingMessage (la misma lógica del
 * bot de WhatsApp); las respuestas se capturan y se devuelven al navegador.
 * El historial se guarda en WhatsappMessage con channel = "WEB".
 */
export const chatRouter = Router();
chatRouter.use(requireAuth);

const MAX_TEXT = 1000;

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

chatRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    res.json({ enabled: env.WEB_CHAT_ENABLED, dailyCap: env.WEB_CHAT_DAILY_CAP });
  })
);

chatRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    requireEnabled();
    const session = await getSession(req.userId!);
    const rows = await prisma.whatsappMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    const used = await usedToday(session.id);
    res.json({ messages: rows.reverse().map(serialize), remainingToday: Math.max(0, env.WEB_CHAT_DAILY_CAP - used) });
  })
);

const sendSchema = z
  .object({ text: z.string().trim().min(1).max(MAX_TEXT).optional(), buttonId: z.string().max(100).optional() })
  .refine((v) => v.text || v.buttonId, { message: "Escribe un mensaje" });

chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    requireEnabled();
    const body = sendSchema.parse(req.body);
    // Un clic en botón equivale al mismo texto que entiende el bot de WhatsApp.
    const text = body.buttonId ? textForButtonReply(body.buttonId) : body.text;
    if (!text) throw new AppError("Botón no reconocido", 400);
    const userId = req.userId!;
    const session = await getSession(userId);

    const used = await usedToday(session.id);
    if (used >= env.WEB_CHAT_DAILY_CAP) {
      throw new AppError("Llegaste al límite de mensajes del chat por hoy. Mañana podrás seguir.", 429);
    }

    await prisma.whatsappMessage.create({
      data: { sessionId: session.id, direction: "INBOUND", content: text, channel: "WEB" },
    });

    let replies;
    try {
      replies = await handleWebMessage(userId, text);
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

    res.json({ replies: saved.map(serialize), remainingToday: Math.max(0, env.WEB_CHAT_DAILY_CAP - used - 1) });
  })
);
