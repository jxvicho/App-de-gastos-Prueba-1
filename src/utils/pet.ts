const DEFAULT_PET_NAME = "Gastón";

/**
 * Nombre "de personalidad" para dirigirse al usuario en los mensajes de
 * WhatsApp (confirmación/descarte/nuevo movimiento) y en el reporte
 * semanal. Si el usuario desactivó la mascota (petType "none"), devuelve
 * null y el llamador debe usar el tono neutro de siempre — nunca
 * inventamos un nombre para alguien que eligió no tener mascota.
 *
 * Si sí tiene mascota pero no le puso nombre propio, cae en "Gastón"
 * (el nombre por defecto que ya usa el selector del sidebar).
 */
export function getPetLabel(
  petType: string | null | undefined,
  petName: string | null | undefined
): string | null {
  if (!petType || petType === "none") return null;
  return petName?.trim() || DEFAULT_PET_NAME;
}
