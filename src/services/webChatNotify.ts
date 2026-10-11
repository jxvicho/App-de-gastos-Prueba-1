import { env } from "../config/env";
import { prisma } from "../config/prisma";

/**
 * Guarda un mensaje del bot en el historial del chat web (channel = WEB). El panel del
 * dashboard lo recoge por polling. No usa Meta: no abre ventana, no cuenta contra el
 * límite de mensajes del plan y funciona en todos los planes.
 */
export async function recordWebBotMessage(
  userId: string,
  text: string,
  buttons?: { id: string; title: string }[]
): Promise<void> {
  if (!env.WEB_CHAT_ENABLED) return;
  try {
    const session = await prisma.whatsappSession.upsert({
      where: { userId },
      update: { lastMessageAt: new Date() },
      create: { userId, waPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "web", lastMessageAt: new Date() },
    });
    await prisma.whatsappMessage.create({
      data: {
        sessionId: session.id,
        direction: "OUTBOUND",
        content: text,
        channel: "WEB",
        buttons: buttons ? (buttons as any) : undefined,
      },
    });
  } catch (err) {
    console.error("Chat web: no se pudo guardar la notificación:", err);
  }
}
