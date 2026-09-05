export const DEFAULT_CATEGORIES: {
  name: string;
  icon: string;
  colorHex: string;
  excludeFromTotals?: boolean;
}[] = [
  { name: "Yape / Plin", icon: "📱", colorHex: "#1a5da8" },
  { name: "Alimentación", icon: "🍽️", colorHex: "#2472c8" },
  { name: "Servicios y utilities", icon: "💡", colorHex: "#0e2f5a" },
  { name: "Otros comercios", icon: "🛍️", colorHex: "#5b93d3" },
  { name: "Transporte", icon: "🚗", colorHex: "#8fb8e8" },
  { name: "Salud", icon: "🩺", colorHex: "#123a6b" },
  { name: "Movimientos financieros", icon: "🏦", colorHex: "#a9bcd4" },
  { name: "Ingresos", icon: "💰", colorHex: "#1a8a5e" },
  { name: "No considerar", icon: "🚫", colorHex: "#c0392b", excludeFromTotals: true },
];
