export const DEFAULT_CATEGORIES: {
  name: string;
  icon: string;
  colorHex: string;
  excludeFromTotals?: boolean;
}[] = [
  { name: "Yape / Plin", icon: "📱", colorHex: "#2F80ED" },
  { name: "Alimentación", icon: "🍽️", colorHex: "#F57C00" },
  { name: "Servicios y utilities", icon: "💡", colorHex: "#8E44AD" },
  { name: "Otros comercios", icon: "🛍️", colorHex: "#607D8B" },
  { name: "Transporte", icon: "🚗", colorHex: "#3F51B5" },
  { name: "Salud", icon: "🩺", colorHex: "#E91E63" },
  { name: "Movimientos financieros", icon: "🏦", colorHex: "#795548" },
  { name: "Ingresos", icon: "💰", colorHex: "#2E9E5B" },
  { name: "No considerar", icon: "🚫", colorHex: "#78909C", excludeFromTotals: true },
];
