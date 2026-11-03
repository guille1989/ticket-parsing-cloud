export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Desviación absoluta mediana: la dispersión que no se deja arrastrar por un día atípico. */
export function medianAbsoluteDeviation(values: number[], center: number = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

export function round(value: number, decimals: number = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const DAY_MS = 86_400_000;

/** Suma días a una fecha `yyyy-MM-dd` (aritmética de calendario, sin husos: la fecha ya es local). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Día de la semana (0 = domingo) de una fecha `yyyy-MM-dd`. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
