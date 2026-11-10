import { prisma } from "../config/prisma";

/**
 * Orden en que se evalúan las reglas de categorización: gana la PRIMERA que coincide.
 * `position` la define el usuario (0 = primera); a igualdad, la más reciente primero.
 */
export const RULE_ORDER_BY = [{ position: "asc" as const }, { createdAt: "desc" as const }];

/** Posición para una regla nueva: arriba de todas, que es lo que hacía el orden anterior (más reciente primero). */
export async function topRulePosition(userId: string): Promise<number> {
  const first = await prisma.categoryRule.aggregate({ where: { userId }, _min: { position: true } });
  return (first._min.position ?? 1) - 1;
}
