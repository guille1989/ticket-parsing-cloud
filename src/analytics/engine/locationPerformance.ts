import { averageTicket, chooseBaseline, dayTotals, pctChange, referenceConfidence, round, selectReferenceDays, windowTotals } from "./compare.js";
import { formatAmount, formatInt, formatPct, formatShare } from "./format.js";
import { addDays, currentCutoff, slotLabel } from "./time.js";
import { UNASSIGNED_AGENT, UNASSIGNED_LABEL, type AnalysisResponse, type Insight, type SalesSlotRow } from "./types.js";

export type LocationPeriod = "today" | "last_7_days";

/** Mínimo de tickets en el periodo para comparar ticket medio entre sucursales (con 2 tickets no hay "mejor"). */
const MIN_TICKETS_FOR_AVG_TICKET = 10;

export interface LocationStat {
  agentId: string;
  branch: string;
  sales: number;
  tickets: number;
  avgTicket: number | null;
  sharePct: number | null;
  referenceSales: number | null;
  /** Variación homologada (misma franja / mismo largo de periodo). null = sin histórico suficiente. */
  growthPct: number | null;
  growthNote: string | null;
  validReferenceDays: number;
}

export interface LocationMetrics {
  period: LocationPeriod;
  locations: number;
  totalSales: number;
  totalTickets: number;
  singleLocation: boolean;
  /** No hay un único "mejor": un ganador por dimensión, cada uno con su criterio. */
  winners: {
    sales: string | null;
    growth: string | null;
    avgTicket: string | null;
  };
  /** Sin costes, horas abiertas ni plantilla no se compara rentabilidad ni productividad. */
  profitability: { available: false; reason: string };
}

export interface LocationInput {
  rows: SalesSlotRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  period: LocationPeriod;
  branchLabels: Map<string, string>;
}

function periodTotals(rows: SalesSlotRow[], agentId: string, days: string[], cutoffSlot?: number): { sales: number; tickets: number } {
  let sales = 0;
  let tickets = 0;
  for (const day of days) {
    const totals = cutoffSlot === undefined ? dayTotals(rows, day, agentId) : windowTotals(rows, day, cutoffSlot, agentId);
    sales += totals.sales;
    tickets += totals.tickets;
  }
  return { sales: round(sales), tickets };
}

export function buildLocationPerformance(input: LocationInput): AnalysisResponse<LocationMetrics, { byLocation: LocationStat[] }> {
  const { rows, now, timeZone, currency, period, branchLabels } = input;
  const { day: today, cutoffSlot } = currentCutoff(now, timeZone);
  const warnings: string[] = [];
  const agents = [...new Set(rows.map((row) => row.agentId))];
  const labelOf = (id: string) => (id === UNASSIGNED_AGENT ? UNASSIGNED_LABEL : (branchLabels.get(id) ?? id));

  // Ventana actual y de referencia según el periodo; las dos comparan lo mismo (misma franja, o 7 días cerrados vs. 7 anteriores).
  const currentDays = period === "today" ? [today] : Array.from({ length: 7 }, (_, i) => addDays(today, -7 + i));
  const previousDays = period === "last_7_days" ? currentDays.map((day) => addDays(day, -7)) : [];
  const cutoff = period === "today" ? cutoffSlot : undefined;
  const tooEarly = period === "today" && cutoffSlot === 0;

  const stats: LocationStat[] = agents.map((agentId) => {
    const current = periodTotals(rows, agentId, currentDays, cutoff);
    let referenceSales: number | null = null;
    let validReferenceDays = 0;
    let growthNote: string | null = null;
    if (period === "today") {
      const refs = selectReferenceDays(rows, today, cutoffSlot, agentId);
      const baseline = chooseBaseline(today, refs.included);
      referenceSales = baseline.sales;
      validReferenceDays = refs.included.length;
      if (baseline.basis === "none") growthNote = "sin histórico suficiente";
      else if (baseline.sales === 0) growthNote = "sin base comparable a esta hora";
    } else {
      const previous = periodTotals(rows, agentId, previousDays);
      referenceSales = previous.tickets > 0 ? previous.sales : null;
      validReferenceDays = previousDays.filter((day) => dayTotals(rows, day, agentId).tickets > 0).length;
      if (previous.tickets === 0) growthNote = "sin histórico suficiente";
      else if (validReferenceDays < 5) growthNote = `la referencia tiene solo ${validReferenceDays} de 7 días con ventas`;
    }
    return {
      agentId,
      branch: labelOf(agentId),
      sales: current.sales,
      tickets: current.tickets,
      avgTicket: averageTicket(current.sales, current.tickets),
      sharePct: null,
      referenceSales,
      growthPct: referenceSales === null ? null : pctChange(current.sales, referenceSales),
      growthNote,
      validReferenceDays,
    };
  });

  const totalSales = round(stats.reduce((sum, s) => sum + s.sales, 0));
  const totalTickets = stats.reduce((sum, s) => sum + s.tickets, 0);
  for (const s of stats) s.sharePct = totalSales > 0 ? round((s.sales / totalSales) * 100, 1) : null;
  stats.sort((a, b) => b.sales - a.sales || a.branch.localeCompare(b.branch));

  // Una sucursal que tuvo ventas en la referencia y hoy ninguna: señal de captura, no un hallazgo de ventas.
  const insights: Insight[] = [];
  for (const s of stats) {
    if (s.tickets === 0 && s.referenceSales !== null && s.referenceSales > 0) {
      insights.push({
        id: `silent_${s.agentId}`,
        kind: "observed",
        headline: `${s.branch} no registra ventas en este periodo pero sí en la referencia (${formatAmount(s.referenceSales, currency)}). Revisá que su captura esté conectada antes de compararla.`,
        evidenceRefs: [`branch:${s.branch}`],
        confidence: "medium",
      });
    }
  }

  const active = stats.filter((s) => s.tickets > 0);
  const singleLocation = agents.length <= 1;
  const salesWinner = active[0] ?? null;
  const growthCandidates = active.filter((s) => s.growthPct !== null && s.growthNote === null);
  const growthWinner = [...growthCandidates].sort((a, b) => (b.growthPct as number) - (a.growthPct as number))[0] ?? null;
  const avgCandidates = active.filter((s) => s.tickets >= MIN_TICKETS_FOR_AVG_TICKET && s.avgTicket !== null);
  const avgWinner = [...avgCandidates].sort((a, b) => (b.avgTicket as number) - (a.avgTicket as number))[0] ?? null;

  if (!singleLocation && salesWinner) {
    insights.unshift({
      id: "sales_leader",
      kind: "observed",
      headline: `${salesWinner.branch} lidera las ventas del periodo con ${formatAmount(salesWinner.sales, currency)}${salesWinner.sharePct === null ? "" : ` (${formatShare(salesWinner.sharePct)} del total)`}.`,
      evidenceRefs: ["ranking:sales"],
      confidence: "high",
    });
    if (growthWinner && growthWinner !== salesWinner) {
      insights.push({
        id: "growth_leader",
        kind: "observed",
        headline: `${growthWinner.branch} es la que más crece (${formatPct(growthWinner.growthPct)}) frente a la referencia homologada.`,
        evidenceRefs: ["ranking:growth"],
        confidence: referenceConfidence(growthWinner.validReferenceDays) ?? "low",
      });
    }
  }

  // Calidad.
  if (singleLocation) warnings.push("El negocio tiene una sola sucursal con ventas: no hay comparación entre sucursales.");
  if (tooEarly) warnings.push("Todavía no cierra ninguna franja de media hora del día.");
  for (const s of stats) {
    if (s.growthNote === "sin histórico suficiente" && s.tickets > 0) warnings.push(`${s.branch}: sin histórico suficiente, no se calcula su variación.`);
  }
  warnings.push("Sin costes, horario de apertura ni plantilla no se compara rentabilidad ni ventas por hora abierta; un local que abre menos horas no está penalizado en las cifras de crecimiento, pero tampoco normalizado.");
  if (period === "today") warnings.push("Comparación hasta la misma hora de corte para todas las sucursales; el avance del día no es el resultado final.");

  const summary = composeSummary({ period, singleLocation, stats, salesWinner, growthWinner, avgWinner, currency, cutoffLabel: slotLabel(cutoffSlot), tooEarly });

  return {
    intent: "location_performance",
    context: {
      timezone: timeZone,
      currency,
      startDay: currentDays[0],
      endDay: currentDays[currentDays.length - 1],
      cutoffLocal: period === "today" && !tooEarly ? slotLabel(cutoffSlot) : null,
      comparison: period === "today" ? "mismo día de la semana a la misma franja horaria" : "últimos 7 días cerrados frente a los 7 anteriores",
      branch: null,
    },
    quality: {
      status: tooEarly || active.length === 0 ? "no_data" : stats.some((s) => s.growthNote === "sin histórico suficiente") ? "partial" : "complete",
      lastSaleAt: null,
      productCoveragePct: null,
      costCoveragePct: null,
      warnings,
    },
    metrics: {
      period,
      locations: stats.length,
      totalSales,
      totalTickets,
      singleLocation,
      winners: { sales: salesWinner?.branch ?? null, growth: growthWinner?.branch ?? null, avgTicket: avgWinner?.branch ?? null },
      profitability: { available: false, reason: "no se dispone de costes ni de datos de operación comparables" },
    },
    breakdowns: { byLocation: stats },
    insights,
    recommendations: [],
    summary,
  };
}

function composeSummary(args: {
  period: LocationPeriod;
  singleLocation: boolean;
  stats: LocationStat[];
  salesWinner: LocationStat | null;
  growthWinner: LocationStat | null;
  avgWinner: LocationStat | null;
  currency: string | null;
  cutoffLabel: string;
  tooEarly: boolean;
}): string {
  const { period, singleLocation, stats, salesWinner, growthWinner, avgWinner, currency, cutoffLabel, tooEarly } = args;
  if (tooEarly) return "Todavía es muy temprano para comparar sucursales: no ha cerrado ninguna franja de media hora del día.";
  if (!salesWinner) return "No hay ventas registradas en este periodo para ninguna sucursal: no puedo compararlas.";
  const when = period === "today" ? `hoy hasta las ${cutoffLabel}` : "en los últimos 7 días";
  if (singleLocation) {
    return `El negocio tiene una sola sucursal con ventas, así que no hay comparación entre locales. ${salesWinner.branch} lleva ${formatAmount(salesWinner.sales, currency)} ${when} (${formatInt(salesWinner.tickets)} tickets).`;
  }
  const second = stats.find((s) => s !== salesWinner && s.tickets > 0);
  const parts = [
    `${salesWinner.branch} lidera las ventas ${when}: ${formatAmount(salesWinner.sales, currency)}${second ? ` frente a ${formatAmount(second.sales, currency)} de ${second.branch}` : ""}.`,
  ];
  if (growthWinner) parts.push(`${growthWinner.branch} es la que más crece (${formatPct(growthWinner.growthPct)} contra la misma referencia).`);
  else parts.push("No hay una sucursal con histórico suficiente para comparar crecimiento.");
  if (avgWinner) parts.push(`El mayor ticket medio es el de ${avgWinner.branch} (${formatAmount(avgWinner.avgTicket as number, currency)}).`);
  parts.push("No elijo un único mejor local: depende del criterio (volumen, crecimiento o ticket medio), y sin costes no puedo decir cuál es más rentable.");
  return parts.join(" ");
}
