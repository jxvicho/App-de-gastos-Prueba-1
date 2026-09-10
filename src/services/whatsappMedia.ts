import { env } from "../config/env";

const GRAPH_BASE_URL = "https://graph.facebook.com";

export interface DownloadedMedia {
  base64: string;
  mimeType: string;
}

/**
 * Descarga un archivo multimedia recibido por WhatsApp (Cloud API). Meta lo
 * exige en 2 pasos: primero se pide la metadata del media (trae una URL
 * firmada temporal, no pública), y luego se baja el binario de esa URL con
 * el mismo Bearer token — no es una URL descargable directamente.
 */
export async function downloadWhatsappMedia(mediaId: string): Promise<DownloadedMedia | null> {
  try {
    const metaRes = await fetch(`${GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!metaRes.ok) {
      console.error(`No se pudo obtener la metadata del media ${mediaId}: HTTP ${metaRes.status}`);
      return null;
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) {
      console.error(`La metadata del media ${mediaId} no trajo una url descargable.`);
      return null;
    }

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!fileRes.ok) {
      console.error(`No se pudo descargar el binario del media ${mediaId}: HTTP ${fileRes.status}`);
      return null;
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    return { base64: buffer.toString("base64"), mimeType: meta.mime_type ?? "image/jpeg" };
  } catch (err) {
    console.error(`Error descargando el media ${mediaId} de WhatsApp:`, err);
    return null;
  }
}
