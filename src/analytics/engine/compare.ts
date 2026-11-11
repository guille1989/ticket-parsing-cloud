import type { Confidence, SalesSlotRow } from "./types.js";
import { SLOTS_PER_DAY, addDays } from "./time.js";

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Variación porcentual. Con base cero o ausente devuelve null ("sin base comparable"):
 * nunca infinito ni un 100 % arbitrario.
 */
export function pctChange(current: number, reference: number | null): number | null {
  if (reference === null || reference === 0) return null;
  return round((current / reference - 1) * 100, 2);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Percentil con interpolación lineal (q entre 0 y 1); null sin datos. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Ticket medio; null si no hubo tickets (no 0). */
export function averageTicket(sales: number, tickets: number): number | null {
  return tickets > 0 ? round(sales / tickets, 2) : null;
}

export interface SalesPoint {
  sales: number;
  tickets: number;
}

export interface SalesDecomposition {
  delta: number;
  /** (N_actual − N_ref) × TM_ref */
  ticketsEffect: number;
  /** N_actual × (TM_actual − TM_ref) */
  avgTicketEffect: number;
}

/**
 * Ventas = tickets × ticket medio. Ambos efectos suman exactamente la variación total:
 * con N_ref = 0 todo el cambio cae en el ticket medio y con N_actual = 0 en los tickets.
 */
export function decompose(current: SalesPoint, reference: SalesPoint): SalesDecomposition {
  const avgCurrent = current.tickets > 0 ? current.sales / current.tickets : 0;
  const avgReference = reference.tickets > 0 ? reference.sales / reference.tickets : 0;
  const ticketsEffect = (current.tickets - reference.tickets) * avgReference;
  const avgTicketEffect = current.tickets * (avgCurrent - avgReference);
  return {
    delta: round(current.sales - reference.sales),
    ticketsEffect: round(ticketsEffect),
    avgTicketEffect: round(avgTicketEffect),
  };
}

export interface WindowTotals extends SalesPoint {
  /** Franja más reciente con tickets dentro de la ventana; null si no hubo ninguno. */
  lastSlot: number | null;
}

/** Ventas y tickets de un día local hasta la franja de corte (excluida), opcionalmente de una sola sucursal. */
export function windowTotals(rows: SalesSlotRow[], day: string, cutoffSlot: number, agentId?: string): WindowTotals {
  let sales = 0;
  let tickets = 0;
  let lastSlot: number | null = null;
  for (const row of rows) {
    if (row.day !== day || row.slot >= cutoffSlot) continue;
    if (agentId !== undefined && row.agentId !== agentId) continue;
    sales += row.sales;
    tickets += row.tickets;
    if (row.tickets > 0 && (lastSlot === null || row.slot > lastSlot)) lastSlot = row.slot;
  }
  return { sales: round(sales), tickets, lastSlot };
}

export function dayTotals(rows: SalesSlotRow[], day: string, agentId?: string): WindowTotals {
  return windowTotals(rows, day, SLOTS_PER_DAY, agentId);
}

export interface ReferenceDay extends SalesPoint {
  day: string;
}

export interface ExcludedDay {
  day: string;
  reason: string;
}

export const REFERENCE_DAYS = 4;
export const LOOKBACK_WEEKS = 8;

/**
 * Hasta `maxDays` mismos días de la semana anteriores, ya recortados a la misma franja de
 * corte. Un día sin ninguna venta (cierre o captura caída) no sirve de referencia y se
 * registra como excluido con su razón: nunca se descarta en silencio.
 */
export function selectReferenceDays(
  rows: SalesSlotRow[],
  today: string,
  cutoffSlot: number,
  agentId?: string,
  maxDays: number = REFERENCE_DAYS,
  lookbackWeeks: number = LOOKBACK_WEEKS,
): { included: ReferenceDay[]; excluded: ExcludedDay[] } {
  const included: ReferenceDay[] = [];
  const excluded: ExcludedDay[] = [];
  for (let week = 1; week <= lookbackWeeks && included.length < maxDays; week++) {
    const day = addDays(today, -7 * week);
    if (dayTotals(rows, day, agentId).tickets === 0) {
      excluded.push({ day, reason: "sin ventas registradas ese día (cierre o captura caída)" });
      continue;
    }
    const { sales, tickets } = windowTotals(rows, day, cutoffSlot, agentId);
    included.push({ day, sales, tickets });
  }
  return { included, excluded };
}

export type BaselineBasis = "same_weekday_last_week" | "median_of_same_weekdays" | "none";

export interface Baseline {
  basis: BaselineBasis;
  sales: number | null;
  tickets: number | null;
  days: string[];
}

/**
 * Referencia principal: el mismo día de la semana pasada si tuvo ventas; si estuvo cerrado
 * o sin captura, la mediana de los otros mismos días válidos.
 */
export function chooseBaseline(today: string, included: ReferenceDay[]): Baseline {
  const days = included.map((entry) => entry.day);
  if (included.length === 0) return { basis: "none", sales: null, tickets: null, days };
  const lastWeek = included.find((entry) => entry.day === addDays(today, -7));
  if (lastWeek) return { basis: "same_weekday_last_week", sales: lastWeek.sales, tickets: lastWeek.tickets, days };
  return {
    basis: "median_of_same_weekdays",
    sales: round(median(included.map((entry) => entry.sales)) ?? 0),
    tickets: median(included.map((entry) => entry.tickets)),
    days,
  };
}

/** Confianza de la referencia según cuántos días equivalentes válidos la respaldan (el documento pide 4-8). */
export function referenceConfidence(validDays: number): Confidence | null {
  if (validDays >= 4) return "high";
  if (validDays >= 2) return "medium";
  if (validDays === 1) return "low";
  return null;
}
