import { averageTicket, chooseBaseline, decompose, pctChange, referenceConfidence, selectReferenceDays, windowTotals, type Baseline, type ExcludedDay, type ReferenceDay, type SalesDecomposition } from "./compare.js";
import { formatAmount, formatInt, formatPct } from "./format.js";
import { addDays, currentCutoff, slotLabel, SLOTS_PER_DAY } from "./time.js";
import { UNASSIGNED_AGENT, UNASSIGNED_LABEL, type AnalysisResponse, type Insight, type SalesSlotRow } from "./types.js";

/** Umbrales del diagnóstico del título. Son de presentación: no cambian ninguna cifra. */
const POSITIVE_FROM_PCT = 5;
const ALERT_FROM_PCT = -10;

export type Diagnosis = "positive" | "neutral" | "alert" | "no_comparison" | "no_data";

/** Día local del negocio: hoy (parcial hasta el corte) o ayer (día cerrado completo). Lo fija el servidor. */
export type BusinessDay = "today" | "yesterday";

export interface BusinessStatusInput {
  rows: SalesSlotRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  /** Si viene, todo el análisis se limita a esa sucursal. */
  branch?: { agentId: string; label: string };
  /** agentId -> nombre visible. */
  branchLabels: Map<string, string>;
  /** Por defecto "today". "yesterday" = día local cerrado, nunca el parcial de hoy. */
  day?: BusinessDay;
}

interface BranchStatus {
  branch: string;
  sales: number;
  tickets: number;
  avgTicket: number | null;
  referenceSales: number | null;
  salesPct: number | null;
  validReferenceDays: number;
}

export interface BusinessStatusMetrics {
  diagnosis: Diagnosis;
  sales: number;
  tickets: number;
  avgTicket: number | null;
  reference: {
    basis: Baseline["basis"];
    sales: number | null;
    tickets: number | null;
    avgTicket: number | null;
    days: ReferenceDay[];
    excluded: ExcludedDay[];
  };
  variation: { salesPct: number | null; ticketsPct: number | null; avgTicketPct: number | null };
  /** Cuánto de la variación en pesos se explica por más/menos tickets y cuánto por el ticket medio. */
  decomposition: SalesDecomposition | null;
  dominantDriver: "tickets" | "avg_ticket" | null;
  /** Sin objetivos diarios cargados no hay progreso de meta: se oculta, no se inventa. */
  goalProgress: null;
}

export function buildBusinessStatus(input: BusinessStatusInput): AnalysisResponse<BusinessStatusMetrics, { byBranch: BranchStatus[] }> {
  const { rows, now, timeZone, currency, branch, branchLabels } = input;
  const dayMode: BusinessDay = input.day ?? "today";
  const { day: todayLocal, cutoffSlot: nowCutoff } = currentCutoff(now, timeZone);
  // Ayer = día local cerrado completo. Nunca se usa el parcial de hoy etiquetado como ayer.
  const day = dayMode === "yesterday" ? addDays(todayLocal, -1) : todayLocal;
  const cutoffSlot = dayMode === "yesterday" ? SLOTS_PER_DAY : nowCutoff;
  const closedDay = dayMode === "yesterday";
  const agentId = branch?.agentId;
  const cutoffLocal = closedDay ? null : slotLabel(cutoffSlot);
  const warnings: string[] = [];

  const observed = windowTotals(rows, day, cutoffSlot, agentId);
  const { included, excluded } = selectReferenceDays(rows, day, cutoffSlot, agentId);
  const baseline = chooseBaseline(day, included);
  const confidence = referenceConfidence(included.length);

  const salesPct = baseline.sales === null ? null : pctChange(observed.sales, baseline.sales);
  const ticketsPct = baseline.tickets === null ? null : pctChange(observed.tickets, baseline.tickets);
  const avgObserved = averageTicket(observed.sales, observed.tickets);
  const avgReference = baseline.sales !== null && baseline.tickets !== null ? averageTicket(baseline.sales, baseline.tickets) : null;
  const avgTicketPct = avgObserved !== null && avgReference !== null ? pctChange(avgObserved, avgReference) : null;

  const decomposition =
    baseline.sales !== null && baseline.tickets !== null && baseline.sales > 0
      ? decompose({ sales: observed.sales, tickets: observed.tickets }, { sales: baseline.sales, tickets: baseline.tickets })
      : null;
  const dominantDriver = decomposition
    ? Math.abs(decomposition.ticketsEffect) >= Math.abs(decomposition.avgTicketEffect)
      ? "tickets"
      : "avg_ticket"
    : null;

  const tooEarly = !closedDay && cutoffSlot === 0;
  const noTickets = observed.tickets === 0;
  let diagnosis: Diagnosis;
  if (tooEarly || noTickets) diagnosis = "no_data";
  else if (salesPct === null) diagnosis = "no_comparison";
  else if (salesPct >= POSITIVE_FROM_PCT) diagnosis = "positive";
  else if (salesPct <= ALERT_FROM_PCT) diagnosis = "alert";
  else diagnosis = "neutral";

  // Por sucursal, solo si no se pidió una y hay más de una con ventas en el historial.
  const agentsSeen = [...new Set(rows.map((row) => row.agentId))];
  const byBranch: BranchStatus[] = [];
  const insights: Insight[] = [];
  if (!branch && agentsSeen.length > 1 && !tooEarly) {
    for (const id of agentsSeen) {
      const own = windowTotals(rows, day, cutoffSlot, id);
      const ownRefs = selectReferenceDays(rows, day, cutoffSlot, id);
      const ownBaseline = chooseBaseline(day, ownRefs.included);
      const label = id === UNASSIGNED_AGENT ? UNASSIGNED_LABEL : (branchLabels.get(id) ?? id);
      const pct = ownBaseline.sales === null ? null : pctChange(own.sales, ownBaseline.sales);
      byBranch.push({
        branch: label,
        sales: own.sales,
        tickets: own.tickets,
        avgTicket: averageTicket(own.sales, own.tickets),
        referenceSales: ownBaseline.sales,
        salesPct: pct,
        validReferenceDays: ownRefs.included.length,
      });
      if (own.tickets === 0 && ownBaseline.sales !== null && ownBaseline.sales > 0) {
        const when = closedDay
          ? `ayer (${day})`
          : `hoy hasta las ${cutoffLocal}`;
        const refWhen = closedDay ? "el mismo día de la semana pasada" : "a esta hora el mismo día de la semana pasada";
        insights.push({
          id: `silent_${byBranch.length}`,
          kind: "observed",
          headline: `${label} no registra ventas ${when}, y ${refWhen} tenía ${formatAmount(ownBaseline.sales, currency)}. Conviene revisar que su captura esté conectada.`,
          evidenceRefs: [`branch:${label}`],
          confidence: "medium",
        });
      }
    }
    byBranch.sort((a, b) => b.sales - a.sales);
  }

  // Calidad.
  if (tooEarly) warnings.push("Todavía no cierra ninguna franja de media hora del día: no hay ventana para comparar.");
  if (!tooEarly && noTickets) {
    warnings.push(
      closedDay
        ? "Sin transacciones observadas ayer (día local cerrado). Antes de concluir que no hubo ventas, verificá que la captura estuviera conectada."
        : "Sin transacciones observadas hoy. Antes de concluir que no hubo ventas, verificá que la captura esté conectada.",
    );
  }
  if (!tooEarly && baseline.basis === "none") warnings.push("No hay días equivalentes con ventas en las últimas 8 semanas: no hay base comparable.");
  if (baseline.basis === "median_of_same_weekdays") warnings.push("El mismo día de la semana pasada no tiene ventas registradas: la referencia es la mediana de los otros mismos días.");
  if (baseline.basis !== "none" && included.length < 4) warnings.push(`La referencia se apoya en ${included.length} día(s) equivalente(s) válido(s); el ideal son 4 o más.`);
  if (closedDay) warnings.push("Ventana de ayer: día local cerrado completo (no el parcial de hoy).");
  warnings.push("No hay objetivo diario cargado: no se calcula progreso de meta.");

  // Insights del total.
  if (salesPct !== null && !tooEarly && !noTickets && confidence) {
    const salesHeadline = closedDay
      ? `Ventas de ayer (${day}): ${formatAmount(observed.sales, currency)} (${formatPct(salesPct)} frente a la referencia).`
      : `Ventas hasta las ${cutoffLocal}: ${formatAmount(observed.sales, currency)} (${formatPct(salesPct)} frente a la referencia).`;
    insights.unshift({
      id: "sales_vs_reference",
      kind: "observed",
      headline: salesHeadline,
      evidenceRefs: ["metric:sales", "metric:reference.sales"],
      confidence,
    });
    if (dominantDriver && decomposition) {
      insights.push({
        id: "driver",
        kind: "observed",
        headline:
          dominantDriver === "tickets"
            ? `La variación se explica sobre todo por el número de tickets (${formatAmount(decomposition.ticketsEffect, currency)}), más que por el ticket medio (${formatAmount(decomposition.avgTicketEffect, currency)}).`
            : `La variación se explica sobre todo por el ticket medio (${formatAmount(decomposition.avgTicketEffect, currency)}), más que por el número de tickets (${formatAmount(decomposition.ticketsEffect, currency)}).`,
        evidenceRefs: ["metric:decomposition"],
        confidence,
      });
    }
  }

  const lastSaleAt = observed.lastSlot === null ? null : slotLabel(observed.lastSlot);
  const summary = composeSummary({
    diagnosis,
    cutoffLocal,
    tooEarly,
    closedDay,
    day,
    observed,
    salesPct,
    ticketsPct,
    avgObserved,
    baseline,
    dominantDriver,
    currency,
    lastSaleAt,
  });

  const comparison =
    baseline.basis === "none"
      ? "sin referencia"
      : closedDay
        ? `${baseline.basis} del día cerrado completo`
        : `${baseline.basis} a la misma franja horaria`;

  return {
    intent: "business_status_today",
    context: {
      timezone: timeZone,
      currency,
      startDay: day,
      endDay: day,
      cutoffLocal: tooEarly || closedDay ? null : cutoffLocal,
      comparison,
      branch: branch?.label ?? null,
    },
    quality: {
      status: noTickets || tooEarly ? "no_data" : baseline.basis === "none" ? "partial" : "complete",
      lastSaleAt,
      productCoveragePct: null,
      costCoveragePct: null,
      warnings,
    },
    metrics: {
      diagnosis,
      sales: observed.sales,
      tickets: observed.tickets,
      avgTicket: avgObserved,
      reference: {
        basis: baseline.basis,
        sales: baseline.sales,
        tickets: baseline.tickets,
        avgTicket: avgReference,
        days: included,
        excluded,
      },
      variation: { salesPct, ticketsPct, avgTicketPct },
      decomposition,
      dominantDriver,
      goalProgress: null,
    },
    breakdowns: { byBranch },
    insights,
    recommendations: [],
    summary,
  };
}

function composeSummary(args: {
  diagnosis: Diagnosis;
  cutoffLocal: string | null;
  tooEarly: boolean;
  closedDay: boolean;
  day: string;
  observed: { sales: number; tickets: number };
  salesPct: number | null;
  ticketsPct: number | null;
  avgObserved: number | null;
  baseline: Baseline;
  dominantDriver: "tickets" | "avg_ticket" | null;
  currency: string | null;
  lastSaleAt: string | null;
}): string {
  const { diagnosis, cutoffLocal, tooEarly, closedDay, day, observed, salesPct, ticketsPct, avgObserved, baseline, dominantDriver, currency, lastSaleAt } = args;
  if (tooEarly) return "Todavía es muy temprano para comparar: no ha cerrado ninguna franja de media hora del día.";
  if (observed.tickets === 0) {
    return closedDay
      ? `Sin transacciones observadas ayer (${day}). Antes de concluir que no hubo ventas, verificá que la captura estuviera conectada.`
      : `Sin transacciones observadas hoy hasta las ${cutoffLocal}. Antes de concluir que no hubo ventas, verificá que la captura esté conectada.`;
  }
  const basis = baseline.basis === "same_weekday_last_week" ? "el mismo día de la semana pasada" : "la mediana de los últimos mismos días de la semana";
  const parts: string[] = closedDay
    ? [`Ayer (${day}) el negocio registró ${formatAmount(observed.sales, currency)}.`]
    : [`Hoy llevas ${formatAmount(observed.sales, currency)} hasta las ${cutoffLocal}.`];
  if (diagnosis === "no_comparison") {
    parts.push(
      closedDay
        ? `No hay una base comparable (${basis} no tuvo ventas), así que no calculo variación.`
        : `No hay una base comparable a esta hora (${basis} no tuvo ventas), así que no calculo variación.`,
    );
  } else {
    parts.push(closedDay ? `Frente a ${basis}, ${formatPct(salesPct)}.` : `Frente a ${basis} a esta misma hora, ${formatPct(salesPct)}.`);
  }
  parts.push(`Tickets: ${formatInt(observed.tickets)}${ticketsPct === null ? "" : ` (${formatPct(ticketsPct)})`}${avgObserved === null ? "" : `; ticket medio ${formatAmount(avgObserved, currency)}`}.`);
  if (dominantDriver) {
    parts.push(dominantDriver === "tickets" ? "El cambio viene sobre todo del número de operaciones." : "El cambio viene sobre todo del ticket medio.");
  }
  if (lastSaleAt) parts.push(`Última venta registrada en la franja de las ${lastSaleAt}.`);
  return parts.join(" ");
}

