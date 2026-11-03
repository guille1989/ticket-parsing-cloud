import { localDate } from "../localTime.js";
import type { MatterCandidate } from "../types.js";
import type { HourlyContext } from "./context.js";
import { round } from "./stats.js";

// La cola que llega acá ya excluye los tickets leídos por visión (ver `loadReviewQueue`): los POS que
// imprimen la factura como imagen entran siempre a revisión y no son una anomalía. Estos umbrales son
// un punto de partida: se afinan con los datos reales antes de activar el job.
const BACKLOG_WARN_COUNT = 10;
const BACKLOG_CRITICAL_COUNT = 30;
const BACKLOG_WARN_AGE_HOURS = 24;
const BACKLOG_CRITICAL_AGE_HOURS = 72;

const MIN_TICKETS_FOR_FAILURE_RATE = 10;
const FAILURE_WARN_RATE = 0.15;
const FAILURE_CRITICAL_RATE = 0.4;

const HOUR_MS = 3_600_000;

/** Tickets esperando que el dueño los revise: muchos, o alguno que lleva días sin atenderse. */
export function detectReviewBacklog(ctx: HourlyContext): MatterCandidate[] {
  const { count, oldestCapturedAt } = ctx.reviewQueue;
  if (count === 0) return [];

  const oldest = oldestCapturedAt ? Date.parse(oldestCapturedAt) : NaN;
  const ageHours = Number.isNaN(oldest) ? 0 : Math.max(0, (ctx.now.getTime() - oldest) / HOUR_MS);

  const critical = count >= BACKLOG_CRITICAL_COUNT || ageHours >= BACKLOG_CRITICAL_AGE_HOURS;
  const warn = count >= BACKLOG_WARN_COUNT || ageHours >= BACKLOG_WARN_AGE_HOURS;
  if (!critical && !warn) return [];

  return [
    {
      detector: "review_backlog",
      scope: "total",
      periodDate: localDate(ctx.now, ctx.timeZone),
      severity: critical ? "critical" : "warn",
      actual: count,
      evidence: { pendingTickets: count, oldestAgeHours: Math.round(ageHours) },
    },
  ];
}

/**
 * Tickets que el parser no pudo leer en la ventana reciente. Si una fracción alta falla, algo
 * cambió en el formato del POS o en la captura, y esas ventas no llegan a las cifras.
 */
export function detectParseFailures(ctx: HourlyContext): MatterCandidate[] {
  const total = ctx.recentTickets.length;
  if (total < MIN_TICKETS_FOR_FAILURE_RATE) return [];

  const failed = ctx.recentTickets.filter((ticket) => ticket.status === "failed").length;
  const rate = failed / total;
  if (rate < FAILURE_WARN_RATE) return [];

  return [
    {
      detector: "data_integrity",
      scope: "total",
      periodDate: localDate(ctx.now, ctx.timeZone),
      severity: rate >= FAILURE_CRITICAL_RATE ? "critical" : "warn",
      expected: 0,
      actual: failed,
      evidence: { failedTickets: failed, totalTickets: total, failureRatePct: round(rate * 100, 1), windowHours: ctx.recentWindowHours },
    },
  ];
}
