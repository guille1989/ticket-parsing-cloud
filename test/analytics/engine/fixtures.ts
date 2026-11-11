import type { SalesSlotRow } from "../../../src/analytics/engine/types";

/** 2026-11-10 es martes. Con America/Bogota (UTC-5), 20:40Z son las 15:40 locales → corte a las 15:30 (franjas < 31). */
export const NOW = new Date("2026-11-10T20:40:00Z");
export const TZ = "America/Bogota";
export const TODAY = "2026-11-10";
export const LAST_TUESDAY = "2026-11-03";
export const CUTOFF_SLOT = 31;

export function row(day: string, slot: number, agentId: string, sales: number, tickets: number): SalesSlotRow {
  return { day, slot, agentId, sales, tickets };
}

/** Un martes: la venta principal cae en la franja 20 (10:00), antes del corte, y otra a las 16:00, después del corte. */
export function tuesday(
  day: string,
  agentId: string,
  untilCutoff: { sales: number; tickets: number },
  afterCutoff = { sales: 400, tickets: 30 },
): SalesSlotRow[] {
  return [row(day, 20, agentId, untilCutoff.sales, untilCutoff.tickets), row(day, 32, agentId, afterCutoff.sales, afterCutoff.tickets)];
}
