import { localDate, localHour, localMinute } from "../../advisor/localTime.js";

export const SLOT_MINUTES = 30;
export const SLOTS_PER_DAY = 48;

/** Suma (o resta) días a una fecha yyyy-MM-dd con aritmética de calendario, sin depender de la zona horaria. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

/** Día de la semana ISO de una fecha local: 1 = lunes … 7 = domingo. */
export function isoWeekday(day: string): number {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** "HH:MM" del inicio de una franja de media hora. */
export function slotLabel(slot: number): string {
  const minutes = slot * SLOT_MINUTES;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export interface Cutoff {
  /** Hoy en fecha local del negocio. */
  day: string;
  /**
   * Cuántas franjas completas van de hoy: se cuentan las franjas con índice menor.
   * A las 15:40 es 31 (hasta las 15:30). El corte se baja a la última media hora cerrada
   * para que hoy y la referencia comparen exactamente la misma ventana.
   */
  cutoffSlot: number;
}

export function currentCutoff(now: Date, timeZone: string): Cutoff {
  const minutes = localHour(now, timeZone) * 60 + localMinute(now, timeZone);
  return { day: localDate(now, timeZone), cutoffSlot: Math.floor(minutes / SLOT_MINUTES) };
}

export { localDate };
