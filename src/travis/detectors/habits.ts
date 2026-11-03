import { localDate } from "../localTime.js";
import type { SalesHourRow } from "../salesHistory.js";
import type { AgentHabit } from "../types.js";
import { addDays, round } from "./stats.js";

export const HABIT_WINDOW_DAYS = 28;
// Con menos días activos no se sabe todavía cuándo trabaja el robot: mejor no vigilarlo que alertar mal.
export const MIN_HABIT_DAYS = 5;

/**
 * Hábito de captura por robot y hora local, sobre los últimos 28 días COMPLETOS (hoy se
 * excluye: está a medias). Se divide por los días con actividad y no por los del calendario,
 * así los días de cierre no diluyen el resultado.
 */
export function buildAgentHabits(history: SalesHourRow[], now: Date, timeZone: string): Record<string, AgentHabit> {
  const today = localDate(now, timeZone);
  const since = addDays(today, -HABIT_WINDOW_DAYS);

  const byAgent = new Map<string, SalesHourRow[]>();
  for (const row of history) {
    if (row.day >= today || row.day < since) continue;
    byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
  }

  const habits: Record<string, AgentHabit> = {};
  for (const [agentId, rows] of byAgent) {
    const activeDays = new Set(rows.map((row) => row.day)).size;
    if (activeDays < MIN_HABIT_DAYS) continue;

    const daysWithTickets: Array<Set<string>> = Array.from({ length: 24 }, () => new Set());
    const tickets = new Array<number>(24).fill(0);
    for (const row of rows) {
      daysWithTickets[row.hour].add(row.day);
      tickets[row.hour] += row.tickets;
    }
    habits[agentId] = {
      activeDays,
      dayShare: daysWithTickets.map((days) => round(days.size / activeDays, 3)),
      avgTickets: tickets.map((count) => round(count / activeDays, 3)),
    };
  }
  return habits;
}
