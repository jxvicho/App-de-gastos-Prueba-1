import { env } from "../config/env";

const GRAPH_BASE_URL = "https://graph.facebook.com";

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

/**
 * Manda un mensaje de texto libre. Solo funciona dentro de la ventana de
 * 24h de conversación abierta por el usuario (o en respuesta a un mensaje
 * suyo) — fuera de esa ventana, Meta requiere sendTemplateMessage.
 * Devuelve el wamid del mensaje enviado (o undefined si falló).
 */
export async function sendTextMessage(to: string, body: string): Promise<string | undefined> {
  try {
    const data = await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    });
    return data.messages?.[0]?.id;
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
  buttons: { id: string; title: string }[]
): Promise<string | undefined> {
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
    return data.messages?.[0]?.id;
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
export async function sendImageMessage(to: string, imageBuffer: Buffer, caption?: string): Promise<string | undefined> {
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
    return data.messages?.[0]?.id;
  } catch (err) {
    console.error(`No se pudo enviar la imagen a ${to}:`, err);
    return undefined;
  }
}

/**
 * Manda un mensaje de tipo plantilla (template), el único tipo permitido
 * para iniciar una conversación fuera de la ventana de 24h. Devuelve el
 * wamid del mensaje enviado (o undefined si falló).
 */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode = "en_US"
): Promise<string | undefined> {
  try {
    const data = await postToGraph({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    });
    return data.messages?.[0]?.id;
  } catch (err) {
    console.error(`No se pudo enviar la plantilla "${templateName}" a ${to}:`, err);
    return undefined;
  }
}
