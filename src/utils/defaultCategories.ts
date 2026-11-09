export const DEFAULT_CATEGORIES: {
  name: string;
  icon: string;
  colorHex: string;
  excludeFromTotals?: boolean;
  kind?: "EXPENSE" | "INCOME";
}[] = [
  { name: "Yape / Plin", icon: "📱", colorHex: "#2F80ED" },
  { name: "Alimentación", icon: "🍽️", colorHex: "#F57C00" },
  { name: "Servicios y utilities", icon: "💡", colorHex: "#8E44AD" },
  { name: "Otros comercios", icon: "🛍️", colorHex: "#607D8B" },
  { name: "Transporte", icon: "🚗", colorHex: "#3F51B5" },
  { name: "Salud", icon: "🩺", colorHex: "#E91E63" },
  { name: "Movimientos financieros", icon: "🏦", colorHex: "#795548" },
  { name: "No considerar", icon: "🚫", colorHex: "#78909C", excludeFromTotals: true },
];

// Categorías de INGRESO (kind = INCOME). Son distintas a las de gasto: no
// aparecen en metas ni en la clasificación de consumos del correo. "Ingresos"
// se mantiene por compatibilidad (el bot y las imágenes de transferencias la
// usan por nombre) y funciona como la categoría general.
export const DEFAULT_INCOME_CATEGORIES: typeof DEFAULT_CATEGORIES = [
  { name: "Ingresos", icon: "💰", colorHex: "#2E9E5B", kind: "INCOME" },
  { name: "Sueldo", icon: "💼", colorHex: "#1B8A5A", kind: "INCOME" },
  { name: "Honorarios y freelance", icon: "🧑‍💻", colorHex: "#2A9D8F", kind: "INCOME" },
  { name: "Ventas y negocio", icon: "🏪", colorHex: "#43A047", kind: "INCOME" },
  { name: "Intereses e inversiones", icon: "📈", colorHex: "#00897B", kind: "INCOME" },
  { name: "Reembolsos y devoluciones", icon: "↩️", colorHex: "#558B2F", kind: "INCOME" },
  { name: "Regalos y transferencias", icon: "🎁", colorHex: "#26A69A", kind: "INCOME" },
];

export const ALL_DEFAULT_CATEGORIES = [...DEFAULT_CATEGORIES, ...DEFAULT_INCOME_CATEGORIES];
