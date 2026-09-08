/** Minúsculas y sin tildes/diacríticos, para comparar texto libre de forma tolerante. */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}
