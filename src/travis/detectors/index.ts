import type { MatterCandidate } from "../types.js";
import { detectAgentOffline, detectCaptureZero } from "./agentHealth.js";
import type { DailyContext, HourlyContext } from "./context.js";
import { detectParseFailures, detectReviewBacklog } from "./dataQuality.js";
import { detectSalesAnomalies } from "./salesAnomaly.js";

export type { DailyContext, HourlyContext } from "./context.js";
export { buildAgentHabits } from "./habits.js";

/** Detectores que necesitan el historial de Athena: corren una vez al día. */
export function runDailyDetectors(ctx: DailyContext): MatterCandidate[] {
  return detectSalesAnomalies(ctx);
}

/** Chequeos baratos (solo DynamoDB): corren cada hora. */
export function runHourlyDetectors(ctx: HourlyContext): MatterCandidate[] {
  return [...detectAgentOffline(ctx), ...detectCaptureZero(ctx), ...detectReviewBacklog(ctx), ...detectParseFailures(ctx)];
}
