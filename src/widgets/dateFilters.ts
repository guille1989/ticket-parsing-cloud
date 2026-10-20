/** Fechas de consulta: valida el calendario, no solo la forma del texto. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))?$/;

export interface DateFilters {
  dateFrom?: string;
  dateTo?: string;
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

export function isValidDateFilter(value: unknown, dateOnly = false): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_ONLY.exec(value) ?? (dateOnly ? null : TIMESTAMP.exec(value));
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  // Date.parse normaliza el 31 de febrero: el round-trip del día lo rechaza.
  const calendarDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return false;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

/** Los timestamps sin sufijo existentes se interpretan siempre como UTC. */
export function normalizeDateFilter(value: string): string {
  if (!isValidDateFilter(value)) throw new Error("fecha ISO-8601 inválida");
  if (isDateOnly(value)) return value;
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  return new Date(zoned).toISOString();
}

/** Se comparte entre creación, consulta y herramientas del asistente. */
export function dateFilterError(range: DateFilters, dateOnly = false): string | undefined {
  for (const key of ["dateFrom", "dateTo"] as const) {
    if (range[key] !== undefined && !isValidDateFilter(range[key], dateOnly)) {
      return `${key} inválida, se esperaba ${dateOnly ? "YYYY-MM-DD" : "una fecha ISO-8601"}`;
    }
  }
  if (range.dateFrom && range.dateTo) {
    // Un día se evalúa en la zona local de la consulta y un instante en
    // UTC. Sin esa zona no se puede comparar un rango heterogéneo.
    if (isDateOnly(range.dateFrom) !== isDateOnly(range.dateTo)) {
      return "dateFrom y dateTo deben usar el mismo formato: ambas fechas YYYY-MM-DD o ambos instantes ISO-8601";
    }
    const from = normalizeDateFilter(range.dateFrom);
    const to = normalizeDateFilter(range.dateTo);
    const fromTime = Date.parse(isDateOnly(from) ? `${from}T00:00:00.000Z` : from);
    const toTime = Date.parse(isDateOnly(to) ? `${to}T23:59:59.999Z` : to);
    if (fromTime > toTime) return "dateFrom no puede ser posterior a dateTo";
  }
  return undefined;
}
