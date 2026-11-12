import { averageTicket, chooseBaseline, decompose, pctChange, referenceConfidence, selectReferenceDays, windowTotals, type Baseline, type ExcludedDay, type ReferenceDay, type SalesDecomposition } from "./compare.js";
import { formatAmount, formatInt, formatPct } from "./format.js";
import { currentCutoff, slotLabel } from "./time.js";
import { UNASSIGNED_AGENT, UNASSIGNED_LABEL, type AnalysisResponse, type Insight, type SalesSlotRow } from "./types.js";

/** Umbrales del diagnóstico del título. Son de presentación: no cambian ninguna cifra. */
const POSITIVE_FROM_PCT = 5;
const ALERT_FROM_PCT = -10;

export type Diagnosis = "positive" | "neutral" | "alert" | "no_comparison" | "no_data";

export interface BusinessStatusInput {
  rows: SalesSlotRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  /** Si viene, todo el análisis se limita a esa sucursal. */
  branch?: { agentId: string; label: string };
  /** agentId -> nombre visible. */
  branchLabels: Map<string, string>;
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
  const { day, cutoffSlot } = currentCutoff(now, timeZone);
  const agentId = branch?.agentId;
  const cutoffLocal = slotLabel(cutoffSlot);
  const warnings: string[] = [];

  const today = windowTotals(rows, day, cutoffSlot, agentId);
  const { included, excluded } = selectReferenceDays(rows, day, cutoffSlot, agentId);
  const baseline = chooseBaseline(day, included);
  const confidence = referenceConfidence(included.length);

  const salesPct = baseline.sales === null ? null : pctChange(today.sales, baseline.sales);
  const ticketsPct = baseline.tickets === null ? null : pctChange(today.tickets, baseline.tickets);
  const avgToday = averageTicket(today.sales, today.tickets);
  const avgReference = baseline.sales !== null && baseline.tickets !== null ? averageTicket(baseline.sales, baseline.tickets) : null;
  const avgTicketPct = avgToday !== null && avgReference !== null ? pctChange(avgToday, avgReference) : null;

  const decomposition =
    baseline.sales !== null && baseline.tickets !== null && baseline.sales > 0
      ? decompose({ sales: today.sales, tickets: today.tickets }, { sales: baseline.sales, tickets: baseline.tickets })
      : null;
  const dominantDriver = decomposition
    ? Math.abs(decomposition.ticketsEffect) >= Math.abs(decomposition.avgTicketEffect)
      ? "tickets"
      : "avg_ticket"
    : null;

  const tooEarly = cutoffSlot === 0;
  const noTicketsToday = today.tickets === 0;
  let diagnosis: Diagnosis;
  if (tooEarly || noTicketsToday) diagnosis = "no_data";
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
        insights.push({
          id: `silent_${byBranch.length}`,
          kind: "observed",
          headline: `${label} no registra ventas hoy hasta las ${cutoffLocal}, y a esta hora el mismo día de la semana pasada tenía ${formatAmount(ownBaseline.sales, currency)}. Conviene revisar que su captura esté conectada.`,
          evidenceRefs: [`branch:${label}`],
          confidence: "medium",
        });
      }
    }
    byBranch.sort((a, b) => b.sales - a.sales);
  }

  // Calidad.
  if (tooEarly) warnings.push("Todavía no cierra ninguna franja de media hora del día: no hay ventana para comparar.");
  if (!tooEarly && noTicketsToday) warnings.push("Sin transacciones observadas hoy. Antes de concluir que no hubo ventas, verificá que la captura esté conectada.");
  if (!tooEarly && baseline.basis === "none") warnings.push("No hay días equivalentes con ventas en las últimas 8 semanas: no hay base comparable.");
  if (baseline.basis === "median_of_same_weekdays") warnings.push("El mismo día de la semana pasada no tiene ventas registradas: la referencia es la mediana de los otros mismos días.");
  if (baseline.basis !== "none" && included.length < 4) warnings.push(`La referencia se apoya en ${included.length} día(s) equivalente(s) válido(s); el ideal son 4 o más.`);
  warnings.push("No hay objetivo diario cargado: no se calcula progreso de meta.");

  // Insights del total.
  if (salesPct !== null && !tooEarly && !noTicketsToday && confidence) {
    insights.unshift({
      id: "sales_vs_reference",
      kind: "observed",
      headline: `Ventas hasta las ${cutoffLocal}: ${formatAmount(today.sales, currency)} (${formatPct(salesPct)} frente a la referencia).`,
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

  const lastSaleAt = today.lastSlot === null ? null : slotLabel(today.lastSlot);
  const summary = composeSummary({ diagnosis, cutoffLocal, tooEarly, today, salesPct, ticketsPct, avgToday, baseline, dominantDriver, currency, lastSaleAt });

  return {
    intent: "business_status_today",
    context: {
      timezone: timeZone,
      currency,
      startDay: day,
      endDay: day,
      cutoffLocal: tooEarly ? null : cutoffLocal,
      comparison: baseline.basis === "none" ? "sin referencia" : `${baseline.basis} a la misma franja horaria`,
      branch: branch?.label ?? null,
    },
    quality: {
      status: noTicketsToday || tooEarly ? "no_data" : baseline.basis === "none" ? "partial" : "complete",
      lastSaleAt,
      productCoveragePct: null,
      costCoveragePct: null,
      warnings,
    },
    metrics: {
      diagnosis,
      sales: today.sales,
      tickets: today.tickets,
      avgTicket: avgToday,
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
  cutoffLocal: string;
  tooEarly: boolean;
  today: { sales: number; tickets: number };
  salesPct: number | null;
  ticketsPct: number | null;
  avgToday: number | null;
  baseline: Baseline;
  dominantDriver: "tickets" | "avg_ticket" | null;
  currency: string | null;
  lastSaleAt: string | null;
}): string {
  const { diagnosis, cutoffLocal, tooEarly, today, salesPct, ticketsPct, avgToday, baseline, dominantDriver, currency, lastSaleAt } = args;
  if (tooEarly) return "Todavía es muy temprano para comparar: no ha cerrado ninguna franja de media hora del día.";
  if (today.tickets === 0) {
    return `Sin transacciones observadas hoy hasta las ${cutoffLocal}. Antes de concluir que no hubo ventas, verificá que la captura esté conectada.`;
  }
  const basis = baseline.basis === "same_weekday_last_week" ? "el mismo día de la semana pasada" : "la mediana de los últimos mismos días de la semana";
  const parts: string[] = [`Hoy llevas ${formatAmount(today.sales, currency)} hasta las ${cutoffLocal}.`];
  if (diagnosis === "no_comparison") {
    parts.push(`No hay una base comparable a esta hora (${basis} no tuvo ventas), así que no calculo variación.`);
  } else {
    parts.push(`Frente a ${basis} a esta misma hora, ${formatPct(salesPct)}.`);
  }
  parts.push(`Tickets: ${formatInt(today.tickets)}${ticketsPct === null ? "" : ` (${formatPct(ticketsPct)})`}${avgToday === null ? "" : `; ticket medio ${formatAmount(avgToday, currency)}`}.`);
  if (dominantDriver) {
    parts.push(dominantDriver === "tickets" ? "El cambio viene sobre todo del número de operaciones." : "El cambio viene sobre todo del ticket medio.");
  }
  if (lastSaleAt) parts.push(`Última venta registrada en la franja de las ${lastSaleAt}.`);
  return parts.join(" ");
}

