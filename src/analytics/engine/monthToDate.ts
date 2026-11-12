import { averageTicket, decompose, pctChange, round, type SalesDecomposition, type SalesPoint } from "./compare.js";
import { formatAmount, formatInt, formatPct } from "./format.js";
import { addDays, currentCutoff, slotLabel } from "./time.js";
import { UNASSIGNED_AGENT, UNASSIGNED_LABEL, type AnalysisResponse, type Insight, type SalesSlotRow } from "./types.js";

const TOP_BRANCHES = 8;

export type MonthToDateStatus = "ok" | "no_comparison" | "no_data";

export interface MonthToDateBranch {
  branch: string;
  current: SalesPoint;
  reference: SalesPoint;
  delta: number;
  /** null con referencia en cero. */
  pct: number | null;
}

export interface MonthToDateMetrics {
  status: MonthToDateStatus;
  window: {
    currentFrom: string;
    currentTo: string;
    referenceFrom: string;
    referenceTo: string;
    cutoffLocal: string | null;
    /** true si el mes anterior es más corto que el día de hoy y la referencia se recortó a su último día. */
    referenceClamped: boolean;
  };
  current: SalesPoint & { avgTicket: number | null; daysWithSales: number; days: number };
  reference: SalesPoint & { avgTicket: number | null; daysWithSales: number; days: number };
  delta: number;
  variation: { salesPct: number | null; ticketsPct: number | null; avgTicketPct: number | null };
  /** Ventas = tickets × ticket medio: los dos efectos suman exactamente `delta`. */
  accounting: SalesDecomposition | null;
}

export interface MonthToDateInput {
  rows: SalesSlotRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  branch?: { agentId: string; label: string };
  branchLabels: Map<string, string>;
}

interface Range {
  from: string;
  to: string;
  /** Día al que se le aplica el corte por franja (hoy); null = todos los días completos. */
  cutDay: string | null;
}

function dayCount(from: string, to: string): number {
  return Number(to.slice(8)) - Number(from.slice(8)) + 1;
}

function sumRange(rows: SalesSlotRow[], range: Range, cutoffSlot: number, keyOf: (row: SalesSlotRow) => string, agentId?: string) {
  const totals = new Map<string, SalesPoint>();
  const daysWithSales = new Set<string>();
  for (const row of rows) {
    if (row.day < range.from || row.day > range.to) continue;
    if (range.cutDay !== null && row.day === range.cutDay && row.slot >= cutoffSlot) continue;
    if (agentId !== undefined && row.agentId !== agentId) continue;
    const key = keyOf(row);
    const entry = totals.get(key) ?? { sales: 0, tickets: 0 };
    entry.sales += row.sales;
    entry.tickets += row.tickets;
    totals.set(key, entry);
    if (row.tickets > 0) daysWithSales.add(row.day);
  }
  let sales = 0;
  let tickets = 0;
  for (const entry of totals.values()) {
    sales += entry.sales;
    tickets += entry.tickets;
  }
  return { total: { sales: round(sales), tickets }, byKey: totals, daysWithSales: daysWithSales.size };
}

/**
 * Lo que va del mes (día 1 hasta hoy, con corte por franja en hoy) contra el mismo tramo del mes anterior
 * (día 1 hasta el mismo número de día, con el mismo corte). Las fechas las fija el servidor.
 */
export function buildMonthToDate(input: MonthToDateInput): AnalysisResponse<MonthToDateMetrics, { byBranch: MonthToDateBranch[] }> {
  const { rows, now, timeZone, currency, branch, branchLabels } = input;
  const { day: today, cutoffSlot } = currentCutoff(now, timeZone);
  const agentId = branch?.agentId;
  const warnings: string[] = [];

  const monthStart = `${today.slice(0, 8)}01`;
  const prevLast = addDays(monthStart, -1);
  const prevStart = `${prevLast.slice(0, 8)}01`;
  const prevDays = Number(prevLast.slice(8));
  const todayNumber = Number(today.slice(8));
  const referenceClamped = todayNumber > prevDays;
  const referenceTo = referenceClamped ? prevLast : `${prevStart.slice(0, 8)}${String(todayNumber).padStart(2, "0")}`;

  const currentRange: Range = { from: monthStart, to: today, cutDay: today };
  // Si la referencia se recorta, su último día es completo: no hay un "mismo día" al que aplicarle el corte.
  const referenceRange: Range = { from: prevStart, to: referenceTo, cutDay: referenceClamped ? null : referenceTo };

  const tooEarly = todayNumber === 1 && cutoffSlot === 0;
  const cutoffLocal = slotLabel(cutoffSlot);

  const current = sumRange(rows, currentRange, cutoffSlot, () => "all", agentId);
  const reference = sumRange(rows, referenceRange, cutoffSlot, () => "all", agentId);
  const delta = round(current.total.sales - reference.total.sales);
  const salesPct = pctChange(current.total.sales, reference.total.sales);
  const ticketsPct = pctChange(current.total.tickets, reference.total.tickets);
  const avgCurrent = averageTicket(current.total.sales, current.total.tickets);
  const avgReference = averageTicket(reference.total.sales, reference.total.tickets);
  const avgTicketPct = avgCurrent !== null && avgReference !== null ? pctChange(avgCurrent, avgReference) : null;
  const accounting = reference.total.sales > 0 ? decompose(current.total, reference.total) : null;

  const currentDays = dayCount(monthStart, today);
  const referenceDaysCount = dayCount(prevStart, referenceTo);

  let status: MonthToDateStatus;
  if (tooEarly || (current.total.tickets === 0 && reference.total.tickets === 0)) status = "no_data";
  else if (reference.total.sales === 0 || salesPct === null) status = "no_comparison";
  else status = "ok";

  // Por sucursal, solo si no se pidió una y hay más de una en el historial.
  const agents = [...new Set(rows.map((row) => row.agentId))];
  const labelOfAgent = (id: string) => (id === UNASSIGNED_AGENT ? UNASSIGNED_LABEL : (branchLabels.get(id) ?? id));
  const byBranch: MonthToDateBranch[] = [];
  if (!branch && agents.length > 1 && !tooEarly) {
    const curBy = sumRange(rows, currentRange, cutoffSlot, (r) => r.agentId).byKey;
    const refBy = sumRange(rows, referenceRange, cutoffSlot, (r) => r.agentId).byKey;
    for (const id of agents) {
      const cur = curBy.get(id) ?? { sales: 0, tickets: 0 };
      const ref = refBy.get(id) ?? { sales: 0, tickets: 0 };
      byBranch.push({
        branch: labelOfAgent(id),
        current: { sales: round(cur.sales), tickets: cur.tickets },
        reference: { sales: round(ref.sales), tickets: ref.tickets },
        delta: round(cur.sales - ref.sales),
        pct: pctChange(cur.sales, ref.sales),
      });
    }
    byBranch.sort((a, b) => b.current.sales - a.current.sales || a.branch.localeCompare(b.branch));
    byBranch.splice(TOP_BRANCHES);
  }

  // Calidad: una referencia con huecos de captura produce variaciones engañosas.
  if (tooEarly) warnings.push("Hoy es día 1 y todavía no cierra ninguna franja de media hora: no hay ventana para comparar.");
  if (!tooEarly && status === "no_data") warnings.push("Sin transacciones observadas en ninguno de los dos tramos. Verificá que la captura esté conectada.");
  if (status === "no_comparison") warnings.push("El tramo del mes anterior no tiene ventas: no hay base comparable.");
  if (!tooEarly && status !== "no_data") {
    if (reference.daysWithSales < referenceDaysCount) {
      warnings.push(`Solo ${reference.daysWithSales} de ${referenceDaysCount} días del tramo del mes anterior tienen ventas registradas (cierre o captura caída): la variación puede ser de cobertura y no de ventas.`);
    }
    if (current.daysWithSales < currentDays - 1) {
      warnings.push(`Solo ${current.daysWithSales} de ${currentDays} días de este mes tienen ventas registradas (cierre o captura caída): la variación puede ser de cobertura y no de ventas.`);
    }
  }
  if (referenceClamped) {
    warnings.push(`El mes anterior tiene ${prevDays} días y hoy es día ${todayNumber}: la referencia se recortó al mes anterior completo (${prevStart} a ${prevLast}).`);
  }
  warnings.push(
    referenceClamped
      ? "Comparación del acumulado del mes (hasta hoy, con corte por franja) contra el mes anterior completo."
      : `Comparación del acumulado del mes (${monthStart} a ${today}, con corte a las ${cutoffLocal} del último día) contra el mismo tramo del mes anterior (${prevStart} a ${referenceTo}).`,
  );

  const insights: Insight[] = [];
  if (status === "ok") {
    insights.push({
      id: "variation",
      kind: "observed",
      headline: `Ventas del ${monthStart} al ${today}: ${formatAmount(current.total.sales, currency)} contra ${formatAmount(reference.total.sales, currency)} del ${prevStart} al ${referenceTo} (${formatPct(salesPct)}).`,
      evidenceRefs: ["metric:current.sales", "metric:reference.sales"],
      confidence: reference.daysWithSales >= referenceDaysCount ? "high" : "medium",
    });
    if (accounting) {
      insights.push({
        id: "accounting",
        kind: "observed",
        headline: `Contablemente, por número de tickets ${formatAmount(accounting.ticketsEffect, currency)} y por ticket medio ${formatAmount(accounting.avgTicketEffect, currency)}.`,
        evidenceRefs: ["metric:accounting"],
        confidence: "high",
      });
    }
  }

  const summary = composeSummary({ status, tooEarly, monthStart, today, prevStart, referenceTo, cutoffLocal, current: current.total, reference: reference.total, salesPct, ticketsPct, avgCurrent, avgReference, avgTicketPct, accounting, currency });

  return {
    intent: "month_to_date",
    context: {
      timezone: timeZone,
      currency,
      startDay: monthStart,
      endDay: today,
      cutoffLocal: tooEarly ? null : cutoffLocal,
      comparison: `acumulado del mes (${monthStart} a ${today}) frente al mismo tramo del mes anterior (${prevStart} a ${referenceTo})`,
      branch: branch?.label ?? null,
    },
    quality: {
      status: status === "no_data" ? "no_data" : status === "no_comparison" ? "partial" : "complete",
      lastSaleAt: null,
      productCoveragePct: null,
      costCoveragePct: null,
      warnings,
    },
    metrics: {
      status,
      window: { currentFrom: monthStart, currentTo: today, referenceFrom: prevStart, referenceTo, cutoffLocal: tooEarly ? null : cutoffLocal, referenceClamped },
      current: { ...current.total, avgTicket: avgCurrent, daysWithSales: current.daysWithSales, days: currentDays },
      reference: { ...reference.total, avgTicket: avgReference, daysWithSales: reference.daysWithSales, days: referenceDaysCount },
      delta,
      variation: { salesPct, ticketsPct, avgTicketPct },
      accounting,
    },
    breakdowns: { byBranch },
    insights,
    recommendations: [],
    summary,
  };
}

function composeSummary(args: {
  status: MonthToDateStatus;
  tooEarly: boolean;
  monthStart: string;
  today: string;
  prevStart: string;
  referenceTo: string;
  cutoffLocal: string;
  current: SalesPoint;
  reference: SalesPoint;
  salesPct: number | null;
  ticketsPct: number | null;
  avgCurrent: number | null;
  avgReference: number | null;
  avgTicketPct: number | null;
  accounting: SalesDecomposition | null;
  currency: string | null;
}): string {
  const { status, tooEarly, monthStart, today, prevStart, referenceTo, cutoffLocal, current, reference, salesPct, ticketsPct, avgCurrent, avgReference, avgTicketPct, accounting, currency } = args;
  if (tooEarly) return "Hoy es día 1 y todavía no cierra ninguna franja de media hora: no hay acumulado del mes para comparar.";
  if (status === "no_data") return "Sin transacciones observadas en este mes ni en el tramo del mes anterior. Verificá que la captura esté conectada antes de concluir algo.";
  if (status === "no_comparison") {
    return `Este mes (${monthStart} a ${today}, hasta las ${cutoffLocal}) llevas ${formatAmount(current.sales, currency)}, pero el tramo del mes anterior (${prevStart} a ${referenceTo}) no tiene ventas: no hay base comparable.`;
  }
  const parts = [
    `Del ${monthStart} al ${today} (hasta las ${cutoffLocal} de hoy) llevas ${formatAmount(current.sales, currency)}, frente a ${formatAmount(reference.sales, currency)} del ${prevStart} al ${referenceTo} del mes anterior (${formatPct(salesPct)}).`,
    `Tickets: ${formatInt(reference.tickets)} → ${formatInt(current.tickets)} (${formatPct(ticketsPct)}); ticket medio: ${avgReference === null ? "sin dato" : formatAmount(avgReference, currency)} → ${avgCurrent === null ? "sin dato" : formatAmount(avgCurrent, currency)} (${formatPct(avgTicketPct)}).`,
  ];
  if (accounting) parts.push(`Contablemente: ${formatAmount(accounting.ticketsEffect, currency)} por número de tickets y ${formatAmount(accounting.avgTicketEffect, currency)} por ticket medio.`);
  return parts.join(" ");
}
