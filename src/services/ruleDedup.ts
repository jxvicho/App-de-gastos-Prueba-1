import { RuleType } from "@prisma/client";
import { prisma } from "../config/prisma";
import { normalizeText } from "../utils/text";

/**
 * Busca una regla del usuario que ya tenga EXACTAMENTE el mismo criterio
 * (mismo tipo y mismo valor), sin importar a qué categoría apunte:
 *  - MERCHANT_CONTAINS: mismo texto, sin distinguir mayúsculas ni tildes.
 *  - AMOUNT_*: mismo número ("50", "50.00" y "50.0" son lo mismo).
 * Sirve para no crear reglas repetidas desde WhatsApp ni desde el dashboard.
 */
export async function findEquivalentRule(userId: string, type: RuleType, value: string) {
  const sameType = await prisma.categoryRule.findMany({
    where: { userId, type },
    include: { category: true },
    orderBy: { createdAt: "asc" },
  });

  if (type === "MERCHANT_CONTAINS") {
    const target = normalizeText(value).trim();
    return sameType.find((r) => normalizeText(r.value).trim() === target) ?? null;
  }

  const targetNumber = parseFloat(value);
  if (Number.isNaN(targetNumber)) return null;
  return sameType.find((r) => parseFloat(r.value) === targetNumber) ?? null;
}
