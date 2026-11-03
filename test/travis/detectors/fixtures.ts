import { addDays } from "../../../src/travis/detectors/stats";
import type { SalesHourRow } from "../../../src/travis/salesHistory";
import type { AgentHabit } from "../../../src/travis/types";

export const NOW = new Date("2026-11-04T07:00:00Z"); // miércoles 4 de noviembre, 07:00 en UTC; "ayer" = martes 2026-11-03

interface HistoryOptions {
  lastDay?: string;
  days?: number;
  agentIds?: string[];
  hours?: number[];
  ticketsPerHour?: number;
  salesPerTicket?: number;
  /** Multiplica tickets y monto de un día/robot; 0 = sin ventas ese día. */
  factor?: (day: string, agentId: string) => number;
}

/** Historial parejo: cada robot vende lo mismo todos los días (400 con los valores por defecto). */
export function buildHistory(options: HistoryOptions = {}): SalesHourRow[] {
  const { lastDay = "2026-11-03", days = 56, agentIds = ["a1"], hours = [10, 11, 12, 13], ticketsPerHour = 5, salesPerTicket = 20, factor = () => 1 } = options;
  const rows: SalesHourRow[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = addDays(lastDay, -offset);
    for (const agentId of agentIds) {
      const multiplier = factor(day, agentId);
      if (multiplier === 0) continue;
      for (const hour of hours) {
        rows.push({ day, hour, agentId, sales: ticketsPerHour * salesPerTicket * multiplier, tickets: Math.round(ticketsPerHour * multiplier) });
      }
    }
  }
  return rows;
}

/** Hábito de un robot que captura `avg` tickets en cada una de `hours` todos los días. */
export function habitFor(hours: number[], avg: number = 5, activeDays: number = 20): AgentHabit {
  return {
    activeDays,
    dayShare: Array.from({ length: 24 }, (_, hour) => (hours.includes(hour) ? 1 : 0)),
    avgTickets: Array.from({ length: 24 }, (_, hour) => (hours.includes(hour) ? avg : 0)),
  };
}
