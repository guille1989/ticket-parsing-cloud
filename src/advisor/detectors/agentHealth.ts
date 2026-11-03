import { localDate, localHour, localMinute } from "../localTime.js";
import type { MatterCandidate } from "../types.js";
import type { HourlyContext } from "./context.js";
import { round } from "./stats.js";

const OFFLINE_AFTER_MINUTES = 30;
const CRITICAL_OFFLINE_MINUTES = 180;
// Una hora cuenta como "de trabajo" si el robot capturó en ella al menos el 30% de sus días activos.
const HABITUAL_SHARE = 0.3;

const ZERO_WINDOW_HOURS = 3;
const MIN_EXPECTED_TICKETS = 3;
const CRITICAL_EXPECTED_TICKETS = 10;

const MINUTE_MS = 60_000;

function minutesSinceSeen(lastSeenAt: string | undefined, now: Date): number | null {
  if (!lastSeenAt) return null;
  const seen = Date.parse(lastSeenAt);
  return Number.isNaN(seen) ? null : Math.max(0, (now.getTime() - seen) / MINUTE_MS);
}

/**
 * Robot sin heartbeat en un horario en que normalmente captura. Fuera de ese horario una PC
 * apagada es lo esperable, y un robot sin hábito (poco historial) no se vigila.
 */
export function detectAgentOffline(ctx: HourlyContext): MatterCandidate[] {
  const hour = localHour(ctx.now, ctx.timeZone);
  const candidates: MatterCandidate[] = [];

  for (const agent of ctx.agents) {
    const habit = ctx.habits[agent.agentId];
    if (!habit || habit.dayShare[hour] < HABITUAL_SHARE) continue;

    const silent = minutesSinceSeen(agent.lastSeenAt, ctx.now);
    if (silent !== null && silent < OFFLINE_AFTER_MINUTES) continue;

    candidates.push({
      detector: "agent_offline",
      scope: `branch:${agent.agentId}`,
      periodDate: localDate(ctx.now, ctx.timeZone),
      severity: silent === null || silent >= CRITICAL_OFFLINE_MINUTES ? "critical" : "warn",
      evidence: {
        agentId: agent.agentId,
        agentName: agent.name,
        minutesSinceSeen: silent === null ? null : Math.round(silent),
        lastSeenAt: agent.lastSeenAt ?? null,
        localHour: hour,
      },
    });
  }
  return candidates;
}

/**
 * El robot responde (heartbeat al día) pero no capturó ningún ticket en una franja donde
 * suele capturar: la PC está viva y el POS o la captura no. Es el caso del Hotel y de
 * Empanadas. Se miran las 3 horas completas anteriores a la actual.
 */
export function detectCaptureZero(ctx: HourlyContext): MatterCandidate[] {
  const hour = localHour(ctx.now, ctx.timeZone);
  const minutesIntoHour = localMinute(ctx.now, ctx.timeZone);
  const windowEnd = ctx.now.getTime() - minutesIntoHour * MINUTE_MS;
  const windowStart = windowEnd - ZERO_WINDOW_HOURS * 60 * MINUTE_MS;
  const windowHours = Array.from({ length: ZERO_WINDOW_HOURS }, (_, i) => (hour - ZERO_WINDOW_HOURS + i + 24) % 24);
  const candidates: MatterCandidate[] = [];

  for (const agent of ctx.agents) {
    const habit = ctx.habits[agent.agentId];
    if (!habit) continue;

    const silent = minutesSinceSeen(agent.lastSeenAt, ctx.now);
    if (silent === null || silent >= OFFLINE_AFTER_MINUTES) continue; // un robot caído lo cubre agent_offline

    const expected = windowHours.reduce((sum, h) => sum + habit.avgTickets[h], 0);
    if (expected < MIN_EXPECTED_TICKETS) continue;

    const captured = ctx.recentTickets.filter((ticket) => {
      if (ticket.agentId !== agent.agentId) return false;
      const at = Date.parse(ticket.capturedAt);
      return at >= windowStart && at < windowEnd;
    }).length;
    if (captured > 0) continue;

    candidates.push({
      detector: "capture_zero",
      scope: `branch:${agent.agentId}`,
      periodDate: localDate(ctx.now, ctx.timeZone),
      severity: expected >= CRITICAL_EXPECTED_TICKETS ? "critical" : "warn",
      expected: round(expected, 1),
      actual: 0,
      evidence: {
        agentId: agent.agentId,
        agentName: agent.name,
        windowHours: ZERO_WINDOW_HOURS,
        minutesSinceSeen: Math.round(silent),
      },
    });
  }
  return candidates;
}
