/** Número con separador de miles y 2 decimales, como en el dashboard: 1234.5 -> "1,234.50". */
export function fmtNum(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
