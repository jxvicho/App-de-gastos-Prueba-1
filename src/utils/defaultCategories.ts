export const DEFAULT_CATEGORIES: {
  name: string;
  icon: string;
  colorHex: string;
  excludeFromTotals?: boolean;
}[] = [
  { name: "Yape / Plin", icon: "📱", colorHex: "#B7D4EF" },
  { name: "Alimentación", icon: "🍽️", colorHex: "#F5CBA3" },
  { name: "Servicios y utilities", icon: "💡", colorHex: "#D6C9EE" },
  { name: "Otros comercios", icon: "🛍️", colorHex: "#D9D6CE" },
  { name: "Transporte", icon: "🚗", colorHex: "#C7CBF0" },
  { name: "Salud", icon: "🩺", colorHex: "#F3C6D9" },
  { name: "Movimientos financieros", icon: "🏦", colorHex: "#DDD5CB" },
  { name: "Ingresos", icon: "💰", colorHex: "#BFE3C9" },
  { name: "No considerar", icon: "🚫", colorHex: "#C9D3E0", excludeFromTotals: true },
];
