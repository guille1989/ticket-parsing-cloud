const amountFormat = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const pctFormat = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1, minimumFractionDigits: 0 });

/** 1248000 → "1.248.000" (+ " COP" si el negocio tiene moneda definida). */
export function formatAmount(value: number, currency: string | null): string {
  const text = amountFormat.format(value);
  return currency ? `${text} ${currency}` : text;
}

/** 13.45 → "+13,5%"; null → "sin base comparable". */
export function formatPct(value: number | null): string {
  if (value === null) return "sin base comparable";
  const text = pctFormat.format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}%`;
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(value);
}

/** 36.04 → "36%": participación (siempre sin signo). */
export function formatShare(value: number): string {
  return `${pctFormat.format(value)}%`;
}
