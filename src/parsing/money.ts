/**
 * Convierte un monto en formato argentino ("$12.300,50", "-$815,00") a number.
 * Convención AR: punto = separador de miles, coma = separador decimal.
 */
export function parseArMoney(raw: string): number {
  const trimmed = raw.trim();
  const negative = trimmed.includes("-");
  const digitsOnly = trimmed.replace(/[^0-9.,]/g, "");
  const normalized = digitsOnly.replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (Number.isNaN(value)) {
    throw new Error(`No se pudo parsear el monto: "${raw}"`);
  }
  return negative ? -Math.abs(value) : value;
}
