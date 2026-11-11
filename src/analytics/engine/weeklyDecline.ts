import { averageTicket, dayTotals, decompose, pctChange, round, windowTotals, type SalesDecomposition, type SalesPoint } from "./compare.js";
import { formatAmount, formatInt, formatPct } from "./format.js";
import type { ProductWindow } from "./productData.js";
import { aggregate, displayName } from "./productStars.js";
import { addDays, currentCutoff, isoWeekday, slotLabel } from "./time.js";
import { UNASSIGNED_AGENT, UNASSIGNED_LABEL, type AnalysisResponse, type Insight, type ProductRow, type SalesSlotRow } from "./types.js";

/** Por debajo de esto la variación es ruido y no se habla de "caída". */
const DECLINE_FROM_PCT = -2;
/** Si las líneas de producto cubren menos de esto de las ventas de los días cerrados, no se atribuye nada a productos. */
const MIN_PRODUCT_COVERAGE_PCT = 60;
const TOP_HOURS = 6;
const TOP_BRANCHES = 8;
const TOP_PRODUCTS = 5;

export type WeeklyStatus = "decline" | "no_decline" | "no_comparison" | "no_data";
export type DriverDimension = "branch" | "day" | "hour" | "product";

export interface DeltaItem {
  label: string;
  current: SalesPoint;
  reference: SalesPoint;
  /** Ventas actuales − ventas de la referencia. */
  delta: number;
  /** null con referencia en cero (sin base comparable). */
  pct: number | null;
}

export interface DayDelta extends DeltaItem {
  referenceDay: string;
  notes: string[];
}

export interface ProductDelta {
  name: string;
  currentRevenue: number;
  referenceRevenue: number;
  revenueDelta: number;
  currentUnits: number;
  referenceUnits: number;
  unitsDelta: number;
  /** Precio realizado = ingresos / unidades; null sin unidades. */
  currentPrice: number | null;
  referencePrice: number | null;
  pricePct: number | null;
}

export interface Driver {
  dimension: DriverDimension;
  label: string;
  /** Cambio en ventas de ese elemento (negativo = cayó). Las dimensiones se solapan: no se suman entre sí. */
  delta: number;
}

export interface WeeklyDeclineMetrics {
  status: WeeklyStatus;
  window: { currentFrom: string; currentTo: string; referenceFrom: string; referenceTo: string; cutoffLocal: string | null };
  current: SalesPoint & { avgTicket: number | null };
  reference: SalesPoint & { avgTicket: number | null };
  delta: number;
  variation: { salesPct: number | null; ticketsPct: number | null; avgTicketPct: number | null };
  /** Ventas = tickets × ticket medio: los dos efectos suman exactamente `delta`. */
  accounting: SalesDecomposition | null;
}

export interface WeeklyDeclineBreakdowns {
  /** De mayor caída a mayor alza; la suma de `delta` de todas las sucursales es la variación total. */
  byBranch: DeltaItem[];
  byDay: DayDelta[];
  /** Mismas horas del día (todos los días de la ventana juntos), de mayor caída a mayor alza. */
  byHour: DeltaItem[];
  /** null = no hay cobertura suficiente de líneas de producto o la ventana no tiene días cerrados. */
  byProduct: ProductDelta[] | null;
  /** Hasta 3 elementos de mayor caída medida, uno por dimensión como máximo. */
  topDrivers: Driver[];
}

export interface ProductEvidence {
  rows: ProductRow[];
  window: ProductWindow;
  truncated?: boolean;
}

export interface WeeklyDeclineInput {
  rows: SalesSlotRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  branch?: { agentId: string; label: string };
  branchLabels: Map<string, string>;
  /** Productos de los días CERRADOS de ambas semanas (hoy es parcial y no tiene corte por hora en esa consulta). */
  products?: ProductEvidence;
  /** Por qué no hay `products`: hoy es lunes (sin días cerrados) o la consulta falló. Se deduce si no se informa. */
  productsStatus?: "no_closed_days" | "failed";
}

/** Lunes de la semana local de un día. */
export function weekStart(day: string): string {
  return addDays(day, -(isoWeekday(day) - 1));
}

/**
 * Ventana de productos: días cerrados de la semana en curso y los mismos días de la anterior.
 * null si hoy es lunes (todavía no hay ningún día cerrado esta semana).
 */
export function closedWeekProductWindow(now: Date, timeZone: string): ProductWindow | null {
  const { day: today } = currentCutoff(now, timeZone);
  const monday = weekStart(today);
  if (monday === today) return null;
  const yesterday = addDays(today, -1);
  return { currentFrom: monday, currentTo: yesterday, previousFrom: addDays(monday, -7), previousTo: addDays(yesterday, -7) };
}

type Totals = Map<string, SalesPoint>;

function collect(rows: SalesSlotRow[], days: Set<string>, cutDay: string, cutoffSlot: number, keyOf: (row: SalesSlotRow) => string, agentId?: string): Totals {
  const out: Totals = new Map();
  for (const row of rows) {
    if (!days.has(row.day) || (row.day === cutDay && row.slot >= cutoffSlot)) continue;
    if (agentId !== undefined && row.agentId !== agentId) continue;
    const entry = out.get(keyOf(row)) ?? { sales: 0, tickets: 0 };
    entry.sales += row.sales;
    entry.tickets += row.tickets;
    out.set(keyOf(row), entry);
  }
  return out;
}

function deltaItems(current: Totals, reference: Totals, labelOf: (key: string) => string): DeltaItem[] {
  const keys = new Set([...current.keys(), ...reference.keys()]);
  return [...keys]
    .map((key): DeltaItem => {
      const cur = current.get(key) ?? { sales: 0, tickets: 0 };
      const ref = reference.get(key) ?? { sales: 0, tickets: 0 };
      return {
        label: labelOf(key),
        current: { sales: round(cur.sales), tickets: cur.tickets },
        reference: { sales: round(ref.sales), tickets: ref.tickets },
        delta: round(cur.sales - ref.sales),
        pct: pctChange(cur.sales, ref.sales),
      };
    })
    .sort((a, b) => a.delta - b.delta || a.label.localeCompare(b.label));
}

function sumTotals(totals: Totals): SalesPoint {
  let sales = 0;
  let tickets = 0;
  for (const entry of totals.values()) {
    sales += entry.sales;
    tickets += entry.tickets;
  }
  return { sales: round(sales), tickets };
}

export function buildWeeklyDecline(input: WeeklyDeclineInput): AnalysisResponse<WeeklyDeclineMetrics, WeeklyDeclineBreakdowns> {
  const { rows, now, timeZone, currency, branch, branchLabels, products, productsStatus } = input;
  const { day: today, cutoffSlot } = currentCutoff(now, timeZone);
  const agentId = branch?.agentId;
  const monday = weekStart(today);
  const refMonday = addDays(monday, -7);
  const refToday = addDays(today, -7);
  const currentDays = Array.from({ length: isoWeekday(today) }, (_, i) => addDays(monday, i));
  const referenceDays = currentDays.map((day) => addDays(day, -7));
  const cutoffLocal = slotLabel(cutoffSlot);
  const tooEarly = currentDays.length === 1 && cutoffSlot === 0;
  const warnings: string[] = [];

  const labelOfAgent = (id: string) => (id === UNASSIGNED_AGENT ? UNASSIGNED_LABEL : (branchLabels.get(id) ?? id));
  const currentSet = new Set(currentDays);
  const referenceSet = new Set(referenceDays);

  const totalCurrent = sumTotals(collect(rows, currentSet, today, cutoffSlot, () => "all", agentId));
  const totalReference = sumTotals(collect(rows, referenceSet, refToday, cutoffSlot, () => "all", agentId));
  const delta = round(totalCurrent.sales - totalReference.sales);
  const salesPct = pctChange(totalCurrent.sales, totalReference.sales);
  const avgCurrent = averageTicket(totalCurrent.sales, totalCurrent.tickets);
  const avgReference = averageTicket(totalReference.sales, totalReference.tickets);
  const ticketsPct = pctChange(totalCurrent.tickets, totalReference.tickets);
  const avgTicketPct = avgCurrent !== null && avgReference !== null ? pctChange(avgCurrent, avgReference) : null;
  const accounting = totalReference.sales > 0 ? decompose(totalCurrent, totalReference) : null;

  let status: WeeklyStatus;
  if (tooEarly || (totalCurrent.tickets === 0 && totalReference.tickets === 0)) status = "no_data";
  else if (totalReference.sales === 0 || salesPct === null) status = "no_comparison";
  else if (salesPct <= DECLINE_FROM_PCT) status = "decline";
  else status = "no_decline";

  // Desgloses. Todos usan la misma ventana (mismo día y hora de corte), por eso reconcilian con el total.
  const agents = [...new Set(rows.map((row) => row.agentId))];
  const byBranch =
    !branch && agents.length > 1
      ? deltaItems(
          collect(rows, currentSet, today, cutoffSlot, (r) => r.agentId),
          collect(rows, referenceSet, refToday, cutoffSlot, (r) => r.agentId),
          labelOfAgent,
        ).slice(0, TOP_BRANCHES)
      : [];
  const hourKey = (row: SalesSlotRow) => String(Math.floor(row.slot / 2)).padStart(2, "0");
  const byHour = deltaItems(
    collect(rows, currentSet, today, cutoffSlot, hourKey, agentId),
    collect(rows, referenceSet, refToday, cutoffSlot, hourKey, agentId),
    (key) => `${key}:00`,
  );

  const byDay: DayDelta[] = currentDays.map((day, i): DayDelta => {
    const referenceDay = referenceDays[i];
    const isToday = day === today;
    const cur = isToday ? windowTotals(rows, day, cutoffSlot, agentId) : dayTotals(rows, day, agentId);
    const ref = isToday ? windowTotals(rows, referenceDay, cutoffSlot, agentId) : dayTotals(rows, referenceDay, agentId);
    const notes: string[] = [];
    if (!isToday && cur.tickets === 0) notes.push("sin ventas registradas este día (cierre o captura caída)");
    if (dayTotals(rows, referenceDay, agentId).tickets === 0) notes.push("sin ventas registradas el día de referencia (cierre o captura caída)");
    return {
      label: day,
      referenceDay,
      current: { sales: cur.sales, tickets: cur.tickets },
      reference: { sales: ref.sales, tickets: ref.tickets },
      delta: round(cur.sales - ref.sales),
      pct: pctChange(cur.sales, ref.sales),
      notes,
    };
  });
  for (const entry of byDay) {
    for (const note of entry.notes) warnings.push(`${entry.label} (referencia ${entry.referenceDay}): ${note}. Esa diferencia puede ser de cobertura y no de ventas.`);
  }

  // Productos: solo días cerrados y solo con cobertura suficiente de líneas.
  let byProduct: ProductDelta[] | null = null;
  let productCoveragePct: number | null = null;
  if (!products) {
    warnings.push(
      productsStatus === "failed"
        ? "No se pudo consultar el detalle por producto: el análisis queda sin esa parte."
        : "Hoy es el primer día de la semana: todavía no hay días cerrados para analizar productos.",
    );
  } else {
    const closedCurrent = new Set(currentDays.filter((d) => d < today));
    const closedReference = new Set(referenceDays.filter((d) => d <= addDays(today, -8)));
    const closedCurrentSales = sumTotals(collect(rows, closedCurrent, "", 0, () => "all", agentId)).sales;
    const closedReferenceSales = sumTotals(collect(rows, closedReference, "", 0, () => "all", agentId)).sales;
    const productCurrent = products.rows.filter((r) => r.period === "current").reduce((sum, r) => sum + r.revenue, 0);
    const productReference = products.rows.filter((r) => r.period === "previous").reduce((sum, r) => sum + r.revenue, 0);
    const denominator = closedCurrentSales + closedReferenceSales;
    productCoveragePct = denominator > 0 ? Math.min(100, round(((productCurrent + productReference) / denominator) * 100, 1)) : null;
    if (productCoveragePct === null || productCoveragePct < MIN_PRODUCT_COVERAGE_PCT) {
      warnings.push(
        `Las líneas de producto cubren ${productCoveragePct === null ? "una parte desconocida" : `${productCoveragePct} %`} de las ventas de los días cerrados: no se atribuye la variación a productos.`,
      );
    } else {
      byProduct = aggregate(products.rows)
        .map((entry): ProductDelta => ({
          name: displayName(entry),
          currentRevenue: round(entry.revenue),
          referenceRevenue: round(entry.previousRevenue),
          revenueDelta: round(entry.revenue - entry.previousRevenue),
          currentUnits: round(entry.units),
          referenceUnits: round(entry.previousUnits),
          unitsDelta: round(entry.units - entry.previousUnits),
          currentPrice: entry.units > 0 ? round(entry.revenue / entry.units) : null,
          referencePrice: entry.previousUnits > 0 ? round(entry.previousRevenue / entry.previousUnits) : null,
          pricePct: entry.units > 0 && entry.previousUnits > 0 ? pctChange(entry.revenue / entry.units, entry.previousRevenue / entry.previousUnits) : null,
        }))
        .sort((a, b) => a.revenueDelta - b.revenueDelta || a.name.localeCompare(b.name))
        .slice(0, TOP_PRODUCTS);
      warnings.push("El detalle por producto cubre solo los días cerrados (sin hoy) y el ingreso por línea antes de impuestos del ticket.");
      if (products.truncated) warnings.push("Se evaluaron los productos de mayor venta; los de muy baja venta pueden faltar.");
    }
  }

  // Factores de mayor caída medida, uno por dimensión; las dimensiones se solapan, no se suman.
  const bestDrop = (dimension: DriverDimension, items: Array<{ label: string; delta: number }>): Driver | null => {
    const worst = items.filter((item) => item.delta < 0).sort((a, b) => a.delta - b.delta)[0];
    return worst ? { dimension, label: worst.label, delta: worst.delta } : null;
  };
  const candidates = [
    bestDrop("branch", byBranch),
    bestDrop("day", byDay.filter((d) => d.notes.length === 0)),
    bestDrop("hour", byHour),
    bestDrop("product", (byProduct ?? []).map((p) => ({ label: p.name, delta: p.revenueDelta }))),
  ].filter((driver): driver is Driver => driver !== null);
  const topDrivers = status === "decline" ? candidates.sort((a, b) => a.delta - b.delta).slice(0, 3) : [];

  // Calidad.
  if (tooEarly) warnings.push("Todavía no cierra ninguna franja de media hora del lunes: no hay ventana para comparar.");
  if (status === "no_data" && !tooEarly) warnings.push("Sin transacciones observadas en ninguna de las dos semanas. Verificá que la captura esté conectada.");
  if (status === "no_comparison") warnings.push("La semana de referencia no tiene ventas en esta misma franja: no hay base comparable.");
  warnings.push("Comparación de semana parcial contra la misma franja de la semana anterior (mismo día y hora de corte), no contra la semana completa.");
  if (totalCurrent.tickets > 0) warnings.push("No hay datos de promociones, precios, stock, festivos, personal ni clima: las causas comerciales no se pueden confirmar.");

  const insights: Insight[] = [];
  if (status !== "no_data" && status !== "no_comparison") {
    insights.push({
      id: "variation",
      kind: "observed",
      headline: `Ventas de la semana hasta el ${today} a las ${cutoffLocal}: ${formatAmount(totalCurrent.sales, currency)} contra ${formatAmount(totalReference.sales, currency)} en la misma franja de la anterior (${formatPct(salesPct)}).`,
      evidenceRefs: ["metric:current.sales", "metric:reference.sales"],
      confidence: "high",
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
  topDrivers.forEach((driver, i) =>
    insights.push({
      id: `driver_${i + 1}`,
      kind: "observed",
      headline: `${DIMENSION_LABEL[driver.dimension]} ${driver.label}: ${formatAmount(driver.delta, currency)} frente a la referencia.`,
      evidenceRefs: [`breakdown:${driver.dimension}`],
      confidence: driver.dimension === "product" ? "medium" : "high",
    }),
  );
  if (status === "decline") {
    insights.push({
      id: "hypotheses",
      kind: "hypothesis",
      headline: "El motivo comercial no está confirmado. Podrían explicarlo la mezcla de productos, los descuentos, los precios, un festivo o un cierre; hay que revisarlo con el equipo.",
      evidenceRefs: [],
      confidence: "low",
    });
  }

  const summary = composeSummary({ status, today, cutoffLocal, totalCurrent, totalReference, salesPct, ticketsPct, avgCurrent, avgReference, avgTicketPct, accounting, topDrivers, currency, tooEarly });

  return {
    intent: "weekly_sales_decline",
    context: {
      timezone: timeZone,
      currency,
      startDay: monday,
      endDay: today,
      cutoffLocal: tooEarly ? null : cutoffLocal,
      comparison: `semana en curso frente a la anterior (${refMonday} a ${refToday}), hasta el mismo día y hora`,
      branch: branch?.label ?? null,
    },
    quality: {
      status: status === "no_data" ? "no_data" : status === "no_comparison" ? "partial" : "complete",
      lastSaleAt: null,
      productCoveragePct,
      costCoveragePct: null,
      warnings,
    },
    metrics: {
      status,
      window: { currentFrom: monday, currentTo: today, referenceFrom: refMonday, referenceTo: refToday, cutoffLocal: tooEarly ? null : cutoffLocal },
      current: { ...totalCurrent, avgTicket: avgCurrent },
      reference: { ...totalReference, avgTicket: avgReference },
      delta,
      variation: { salesPct, ticketsPct, avgTicketPct },
      accounting,
    },
    breakdowns: { byBranch, byDay, byHour: byHour.slice(0, TOP_HOURS), byProduct, topDrivers },
    insights,
    recommendations: [],
    summary,
  };
}

const DIMENSION_LABEL: Record<DriverDimension, string> = {
  branch: "Sucursal",
  day: "Día",
  hour: "Franja de las",
  product: "Producto",
};

function composeSummary(args: {
  status: WeeklyStatus;
  today: string;
  cutoffLocal: string;
  totalCurrent: SalesPoint;
  totalReference: SalesPoint;
  salesPct: number | null;
  ticketsPct: number | null;
  avgCurrent: number | null;
  avgReference: number | null;
  avgTicketPct: number | null;
  accounting: SalesDecomposition | null;
  topDrivers: Driver[];
  currency: string | null;
  tooEarly: boolean;
}): string {
  const { status, today, cutoffLocal, totalCurrent, totalReference, salesPct, ticketsPct, avgCurrent, avgReference, avgTicketPct, accounting, topDrivers, currency, tooEarly } = args;
  if (tooEarly) return "Todavía es muy temprano del lunes para comparar la semana: no ha cerrado ninguna franja de media hora.";
  if (status === "no_data") return "Sin transacciones observadas en esta semana ni en la anterior. Verificá que la captura esté conectada antes de concluir algo.";
  if (status === "no_comparison") return `Esta semana llevas ${formatAmount(totalCurrent.sales, currency)} hasta el ${today} a las ${cutoffLocal}, pero la semana anterior no tiene ventas en esa misma franja: no hay base comparable.`;

  const head = `Esta semana acumulas ${formatAmount(totalCurrent.sales, currency)} hasta el ${today} a las ${cutoffLocal}, frente a ${formatAmount(totalReference.sales, currency)} en la misma franja de la semana pasada (${formatPct(salesPct)}).`;
  const detail =
    `Tickets: ${formatInt(totalReference.tickets)} → ${formatInt(totalCurrent.tickets)} (${formatPct(ticketsPct)}); ` +
    `ticket medio: ${avgReference === null ? "sin dato" : formatAmount(avgReference, currency)} → ${avgCurrent === null ? "sin dato" : formatAmount(avgCurrent, currency)} (${formatPct(avgTicketPct)}).`;
  if (status === "no_decline") return `No se observa una caída comparable. ${head} ${detail}`;

  const parts = [head, detail];
  if (accounting) parts.push(`Contablemente: ${formatAmount(accounting.ticketsEffect, currency)} por número de tickets y ${formatAmount(accounting.avgTicketEffect, currency)} por ticket medio.`);
  if (topDrivers.length > 0) {
    parts.push(`Mayor caída medida: ${topDrivers.map((d) => `${DIMENSION_LABEL[d.dimension].toLowerCase()} ${d.label} (${formatAmount(d.delta, currency)})`).join("; ")}. Son cortes distintos de la misma caída: no se suman.`);
  }
  parts.push("El motivo comercial aún no está confirmado: conviene revisar la mezcla de productos, los descuentos y los precios.");
  return parts.join(" ");
}
