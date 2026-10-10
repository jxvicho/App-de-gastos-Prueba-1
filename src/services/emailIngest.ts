import type { Transaction, User } from "@prisma/client";
import { getEffectivePlan } from "./plans";
import { notifyAutoRegisteredTransaction, notifyPendingTransaction } from "./whatsappBot";
import { processAlertsForTransaction } from "./alerts";
import { getPetLabel } from "../utils/pet";

export type IngestStatus = "AUTO_CONFIRMED" | "PENDING_CONFIRMATION";

/**
 * Cómo se registra un consumo detectado en el correo, según el plan EFECTIVO:
 *  - BASIC / PRO: siempre automático (AUTO_CONFIRMED) y sin mensajes por consumo.
 *  - UNLIMITED: el comportamiento de siempre — pendiente con aviso y botones, o
 *    automático con aviso si el usuario activó el "registro automático".
 */
export async function resolveIngestStatus(user: User): Promise<IngestStatus> {
  const eff = await getEffectivePlan(user);
  if (eff.plan !== "UNLIMITED") return "AUTO_CONFIRMED";
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

  if (eff.plan === "UNLIMITED") {
    const notify = created.status === "AUTO_CONFIRMED" ? notifyAutoRegisteredTransaction : notifyPendingTransaction;
    await notify(withCategory, user.phoneNumber, pet);
  }

  if (eff.plan === "PRO" || eff.plan === "UNLIMITED") {
    await processAlertsForTransaction(user, created, category);
  }
}
