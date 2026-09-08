import { env } from "../config/env";

const GRAPH_BASE_URL = "https://graph.facebook.com";

function messagesUrl(): string {
  return `${GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function postToGraph(payload: Record<string, unknown>): Promise<void> {
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
}

/**
 * Manda un mensaje de texto libre. Solo funciona dentro de la ventana de
 * 24h de conversación abierta por el usuario (o en respuesta a un mensaje
 * suyo) — fuera de esa ventana, Meta requiere sendTemplateMessage.
 */
export async function sendTextMessage(to: string, body: string): Promise<void> {
  try {
    await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    });
  } catch (err) {
    console.error(`No se pudo enviar el mensaje de texto a ${to}:`, err);
  }
}

/**
 * Manda un mensaje con hasta 3 botones de respuesta rápida ("reply
 * buttons"). Igual que sendTextMessage, solo funciona dentro de la
 * ventana de 24h. El título de cada botón debe tener 20 caracteres o menos
 * (límite de la Graph API).
 */
export async function sendInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<void> {
  try {
    await postToGraph({
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
  } catch (err) {
    console.error(`No se pudieron enviar los botones a ${to}:`, err);
  }
}

/**
 * Manda un mensaje de tipo plantilla (template), el único tipo permitido
 * para iniciar una conversación fuera de la ventana de 24h.
 */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode = "en_US"
): Promise<void> {
  try {
    await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    });
  } catch (err) {
    console.error(`No se pudo enviar la plantilla "${templateName}" a ${to}:`, err);
  }
}
