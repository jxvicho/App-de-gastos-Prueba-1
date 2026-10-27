import type { Transaction, User } from "@prisma/client";
import { getEffectivePlan } from "./plans";
import { notifyAutoRegisteredTransaction, notifyPendingTransaction, notifyWebChatTransaction } from "./whatsappBot";
import { processAlertsForTransaction } from "./alerts";
import { getPetLabel } from "../utils/pet";

export type IngestStatus = "AUTO_CONFIRMED" | "PENDING_CONFIRMATION";

/**
 * Cómo se registra un consumo detectado en el correo, según el plan EFECTIVO:
 *  - BASIC: siempre manual (PENDING_CONFIRMATION, se confirma desde el chat web o "Por revisar").
 *  - PRO / UNLIMITED: el usuario elige con el "registro automático": manual (pendiente) o automático.
 *  Los avisos por WhatsApp de cada consumo solo existen en UNLIMITED; en los demás el aviso va al chat web.
 */
export async function resolveIngestStatus(user: User): Promise<IngestStatus> {
  const eff = await getEffectivePlan(user);
  if (eff.plan === "BASIC") return "PENDING_CONFIRMATION";
  return user.autoRegister ? "AUTO_CONFIRMED" : "PENDING_CONFIRMATION";
}

/**
 * Se llama justo después de crear la transacción del correo: manda el aviso por
 * consumo (solo UNLIMITED; si la ventana de 24 h está cerrada el envío se omite
 * y la transacción queda visible en "Por revisar") y evalúa las alertas (PRO y
 * UNLIMITED).
 */
export async function afterEmailTransactionCreated(
  user: User,
  created: Transaction,
  category: { id: string; name: string } | null
): Promise<void> {
  const eff = await getEffectivePlan(user);
  const withCategory = { ...created, category: category ? { name: category.name } : null };
  const pet = getPetLabel(user.petType, user.petName);

  // Chat web: el aviso llega a TODOS los planes (no cuesta mensajes de Meta). El de WhatsApp no cambia.
  await notifyWebChatTransaction(user.id, withCategory, pet);

  if (eff.plan === "UNLIMITED") {
    const notify = created.status === "AUTO_CONFIRMED" ? notifyAutoRegisteredTransaction : notifyPendingTransaction;
    await notify(withCategory, user.phoneNumber, pet);
  }

  if (eff.plan === "PRO" || eff.plan === "UNLIMITED") {
    await processAlertsForTransaction(user, created, category);
  }
}
