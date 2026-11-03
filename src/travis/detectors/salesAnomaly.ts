import { localDate } from "../localTime.js";
import type { SalesHourRow } from "../salesHistory.js";
import type { MatterCandidate, MatterSeverity } from "../types.js";
import type { DailyContext } from "./context.js";
import { addDays, median, medianAbsoluteDeviation, round } from "./stats.js";

// Se compara ayer con el mismo día de la semana de las semanas anteriores: un lunes contra
// lunes, no contra el domingo. Un negocio vende distinto cada día, así que es la única
// comparación justa; y como se mira solo el pasado reciente, un cambio de régimen se vuelve
// el nuevo normal en pocas semanas en vez de alertar para siempre.
const BASELINE_WEEKS = 6;
const MIN_BASELINE_DAYS = 4;
// Sin actividad suficiente en la base, cualquier variación es ruido (y un negocio cerrado ese día no es una caída).
const MIN_BASELINE_TICKETS = 5;
// Si los días de la base son casi idénticos la dispersión sería ~0 y cualquier cambio daría z enorme:
// se asume al menos esta variación relativa.
const SCALE_FLOOR = 0.15;
const MAD_TO_SIGMA = 1.4826;

// Hace falta que el desvío sea estadísticamente raro (z) Y grande en términos de negocio (%).
const WARN_Z = 2;
const WARN_PCT = 0.2;
const CRITICAL_Z = 3;
const CRITICAL_PCT = 0.35;

interface DayTotals {
  sales: number;
  tickets: number;
}
const NO_SALES: DayTotals = { sales: 0, tickets: 0 };

type DailySeries = Map<string, DayTotals>;

function addTo(series: DailySeries, day: string, row: SalesHourRow) {
  const totals = series.get(day) ?? { sales: 0, tickets: 0 };
  totals.sales += row.sales;
  totals.tickets += row.tickets;
  series.set(day, totals);
}

function classify(z: number, pct: number): { direction: "drop" | "spike"; severity: MatterSeverity } | null {
  if (z <= -WARN_Z && pct <= -WARN_PCT) {
    return { direction: "drop", severity: z <= -CRITICAL_Z && pct <= -CRITICAL_PCT ? "critical" : "warn" };
  }
  // Un pico es una buena noticia que conviene saber, no un riesgo: nunca pasa de "warn".
  if (z >= WARN_Z && pct >= WARN_PCT) {
    return { direction: "spike", severity: z >= CRITICAL_Z && pct >= CRITICAL_PCT ? "warn" : "info" };
  }
  return null;
}

/** Ventas de ayer vs. lo habitual para ese día de la semana: total del negocio y de cada sucursal. */
export function detectSalesAnomalies(ctx: DailyContext): MatterCandidate[] {
  const target = addDays(localDate(ctx.now, ctx.timeZone), -1);

  const byScope = new Map<string, DailySeries>();
  for (const row of ctx.history) {
    for (const scope of ["total", `branch:${row.agentId}`]) {
      const series = byScope.get(scope) ?? new Map<string, DayTotals>();
      addTo(series, row.day, row);
      byScope.set(scope, series);
    }
  }

  const candidates: MatterCandidate[] = [];
  for (const [scope, series] of byScope) {
    // Antes del primer día con datos de este alcance no hay "cero ventas": todavía no existía.
    const firstDay = [...series.keys()].sort()[0];
    const baselineDays = Array.from({ length: BASELINE_WEEKS }, (_, i) => addDays(target, -7 * (i + 1))).filter((day) => day >= firstDay);
    if (baselineDays.length < MIN_BASELINE_DAYS) continue;

    const baseline = baselineDays.map((day) => series.get(day) ?? NO_SALES);
    const expectedSales = median(baseline.map((day) => day.sales));
    const expectedTickets = median(baseline.map((day) => day.tickets));
    if (expectedTickets < MIN_BASELINE_TICKETS || expectedSales <= 0) continue;

    const actual = series.get(target) ?? NO_SALES;
    const spread = Math.max(MAD_TO_SIGMA * medianAbsoluteDeviation(baseline.map((day) => day.sales), expectedSales), SCALE_FLOOR * expectedSales);
    const z = (actual.sales - expectedSales) / spread;
    const pct = (actual.sales - expectedSales) / expectedSales;

    const verdict = classify(z, pct);
    if (!verdict) continue;
    candidates.push({
      detector: "sales_anomaly",
      scope,
      periodDate: target,
      severity: verdict.severity,
      expected: round(expectedSales),
      actual: round(actual.sales),
      evidence: {
        direction: verdict.direction,
        deltaPct: round(pct * 100, 1),
        z: round(z, 2),
        baselineDays: baseline.length,
        expectedTickets: round(expectedTickets, 1),
        actualTickets: actual.tickets,
        ...(scope === "total" ? {} : { agentId: scope.slice("branch:".length) }),
      },
    });
  }
  return candidates;
}
