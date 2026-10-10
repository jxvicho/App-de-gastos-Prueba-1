const DEFAULT_PET_NAME = "Gastón";

// Un emoji por cada mascota real (ver enum PetType en schema.prisma:
// dog/cat/capybara/pig/none) — así el mensaje de WhatsApp muestra la
// mascota que el usuario eligió de verdad, no siempre la misma patita de
// perro. "🐾" queda solo como último respaldo ante un petType inesperado
// (nunca debería pasar, pero evita quedarnos sin ícono si el enum crece).
const PET_EMOJI_BY_TYPE: Record<string, string> = {
  dog: "🐶",
  cat: "🐱",
  capybara: "🦫",
  pig: "🐷",
};
const FALLBACK_PET_EMOJI = "🐾";

export interface PetPersona {
  name: string;
  emoji: string;
}

/**
 * Nombre + emoji "de personalidad" para dirigirse al usuario en los mensajes
 * de WhatsApp (confirmación/descarte/nuevo movimiento) y en el reporte
 * semanal — el emoji corresponde a la mascota elegida de verdad (🐶/🐱/🦫/🐷),
 * nunca uno fijo. Si el usuario desactivó la mascota (petType "none"),
 * devuelve null y el llamador debe usar el tono neutro de siempre — nunca
 * inventamos una mascota para alguien que eligió no tener una.
 *
 * Si sí tiene mascota pero no le puso nombre propio, cae en "Gastón" (el
 * nombre por defecto que ya usa el selector del sidebar).
 */
export function getPetLabel(
  petType: string | null | undefined,
  petName: string | null | undefined
): PetPersona | null {
  if (!petType || petType === "none") return null;
  return {
    name: petName?.trim() || DEFAULT_PET_NAME,
    emoji: PET_EMOJI_BY_TYPE[petType] ?? FALLBACK_PET_EMOJI,
  };
}
