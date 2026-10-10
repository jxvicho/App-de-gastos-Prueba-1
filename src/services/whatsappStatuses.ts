import { prisma } from "../config/prisma";
import { META_RATE_BY_CATEGORY_USD, META_RATE_USD_PE } from "../config/plans";

interface MetaStatus {
  id?: string; // wamid del mensaje que enviamos
  status?: string; // sent | delivered | read | failed
  pricing?: { billable?: boolean; pricing_model?: string; type?: string; category?: string };
  errors?: { code?: number; title?: string }[];
}

/**
 * Procesa `value.statuses` del webhook de Meta. Del objeto `pricing` guarda
 * billable, tipo y categoría en OutboundMessage (por wamid) y calcula costUsd
 * cuando el mensaje es cobrable. Meta repite el pricing en varios estados
 * (sent/delivered): se calcula una sola vez.
 */
export async function recordStatuses(statuses: MetaStatus[]): Promise<void> {
  for (const st of statuses) {
    try {
      if (!st.id) continue;

      if (st.status === "failed") {
        console.error(
          `WhatsApp: el mensaje ${st.id} no se entregó:`,
          (st.errors ?? []).map((e) => `${e.code ?? "?"} ${e.title ?? ""}`).join("; ") || "sin detalle"
        );
      }

      const pricing = st.pricing;
      if (!pricing) continue;

      const existing = await prisma.outboundMessage.findUnique({ where: { wamid: st.id } });
      if (!existing || existing.billable !== null) continue; // desconocido o ya procesado

      const billable = pricing.billable === true;
      const category = pricing.category ?? null;
      const costUsd = billable ? META_RATE_BY_CATEGORY_USD[category ?? ""] ?? META_RATE_USD_PE : 0;

      await prisma.outboundMessage.update({
        where: { wamid: st.id },
        data: { billable, category, pricingType: pricing.type ?? pricing.pricing_model ?? null, costUsd },
      });
    } catch (err) {
      console.error("No se pudo registrar el estado/pricing de un mensaje de WhatsApp:", err);
    }
  }
}
