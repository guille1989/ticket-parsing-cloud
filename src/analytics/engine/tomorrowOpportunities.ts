import { averageTicket, dayTotals, median, quantile, round } from "./compare.js";
import { formatAmount, formatInt, formatShare } from "./format.js";
import { aggregate, displayName } from "./productStars.js";
import { addDays, currentCutoff, isoWeekday } from "./time.js";
import type { AnalysisResponse, Confidence, Insight, ProductRow, Recommendation, SalesSlotRow } from "./types.js";

/** Cuántos mismos días de la semana pasados se miran (el documento pide 4-8). */
export const REFERENCE_WEEKS = 8;
/** Con menos días válidos que esto no se pronostica ni se recomienda. */
const MIN_VALID_DAYS = 3;
/**
 * Si al menos esta fracción de los mismos días que YA tenían historial no registró ventas, se asume que ese
 * día el negocio no abre. Los días anteriores al inicio del historial no cuentan: un negocio nuevo no es un negocio cerrado.
 */
const LIKELY_CLOSED_RATIO = 0.6;
const MIN_HISTORY_DAYS_FOR_CLOSED = 4;
/** Una franja es débil si su venta típica es menos de esta fracción de la de una franja típica del día. */
const WEAK_RATIO = 0.5;
/**
 * Supuesto de escenario (no un dato): se recupera entre el 10 % y el 25 % de la diferencia entre una franja
 * débil y una franja típica. Se muestra siempre junto al rango.
 */
const RECOVERY_LOW = 0.1;
const RECOVERY_HIGH = 0.25;

const WEEKDAY_NAME = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

export type TomorrowStatus = "ok" | "insufficient_history" | "likely_closed";

export interface TomorrowMetrics {
  status: TomorrowStatus;
  tomorrow: { day: string; weekday: string };
  /** Pronóstico baseline: percentiles de las ventas completas de los mismos días de la semana. null si no se pudo. */
  forecast: {
    sales: { low: number; median: number; high: number };
    tickets: number | null;
    avgTicket: number | null;
    validDays: number;
    confidence: Confidence;
  } | null;
  referenceDays: { valid: string[]; excluded: Array<{ day: string; reason: string }> };
  /** Solo la acción cuantificada aporta al potencial; las demás no se estiman y por eso no se suman. */
  potential: { revenue: { low: number; high: number } | null; note: string };
}

export interface HourProfile {
  hour: string;
  /** Mediana de ventas de esa hora en los días de referencia (los días sin venta cuentan como 0). */
  medianSales: number;
  /** Días de referencia con ventas en esa hora. */
  activeDays: number;
}

export interface TomorrowBreakdowns {
  hourlyProfile: HourProfile[];
  topProducts: Array<{ name: string; unitsPerDay: number; sharePctOfUnits: number | null }>;
}

export interface TomorrowInput {
  rows: SalesSlotRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  branch?: { agentId: string; label: string };
  /** Productos vendidos en los mismos días de referencia (todas las fechas de `tomorrowReferenceDates`). */
  products?: { rows: ProductRow[]; truncated?: boolean };
  productsStatus?: "failed";
}

/** Mañana en fecha local y los 8 mismos días de la semana anteriores. */
export function tomorrowReferenceDates(now: Date, timeZone: string): { tomorrow: string; dates: string[] } {
  const tomorrow = addDays(currentCutoff(now, timeZone).day, 1);
  return { tomorrow, dates: Array.from({ length: REFERENCE_WEEKS }, (_, i) => addDays(tomorrow, -7 * (i + 1))) };
}

function confidenceFor(validDays: number): Confidence {
  return validDays >= 6 ? "high" : validDays >= 4 ? "medium" : "low";
}

const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const hourRange = (from: number, toInclusive: number) => `${hourLabel(from)}–${hourLabel(toInclusive + 1)}`;

export function buildTomorrowOpportunities(input: TomorrowInput): AnalysisResponse<TomorrowMetrics, TomorrowBreakdowns> {
  const { rows, now, timeZone, currency, branch, products, productsStatus } = input;
  const { tomorrow, dates } = tomorrowReferenceDates(now, timeZone);
  const agentId = branch?.agentId;
  const weekday = WEEKDAY_NAME[isoWeekday(tomorrow)];
  const warnings: string[] = [];

  const valid: string[] = [];
  const excluded: Array<{ day: string; reason: string }> = [];
  const scoped = agentId === undefined ? rows : rows.filter((r) => r.agentId === agentId);
  const firstDataDay = scoped.reduce<string | null>((first, r) => (first === null || r.day < first ? r.day : first), null);
  let closedDays = 0;
  for (const day of dates) {
    if (dayTotals(rows, day, agentId).tickets > 0) valid.push(day);
    else if (firstDataDay === null || day < firstDataDay) excluded.push({ day, reason: "anterior al inicio del historial" });
    else {
      closedDays++;
      excluded.push({ day, reason: "sin ventas registradas ese día (cierre o captura caída)" });
    }
  }
  const daysWithHistory = valid.length + closedDays;

  const context = {
    timezone: timeZone,
    currency,
    startDay: tomorrow,
    endDay: tomorrow,
    cutoffLocal: null,
    comparison: `mismos ${weekday}s de las últimas ${REFERENCE_WEEKS} semanas`,
    branch: branch?.label ?? null,
  };
  const empty = (status: TomorrowStatus, summary: string, extraWarning: string): AnalysisResponse<TomorrowMetrics, TomorrowBreakdowns> => ({
    intent: "increase_tomorrow_sales",
    context,
    quality: { status: "no_data", lastSaleAt: null, productCoveragePct: null, costCoveragePct: null, warnings: [extraWarning] },
    metrics: {
      status,
      tomorrow: { day: tomorrow, weekday },
      forecast: null,
      referenceDays: { valid, excluded },
      potential: { revenue: null, note: "Sin pronóstico no hay potencial calculable." },
    },
    breakdowns: { hourlyProfile: [], topProducts: [] },
    insights: [],
    recommendations: [],
    summary,
  });

  if (daysWithHistory >= MIN_HISTORY_DAYS_FOR_CLOSED && closedDays / daysWithHistory >= LIKELY_CLOSED_RATIO) {
    return empty(
      "likely_closed",
      `En ${closedDays} de los últimos ${daysWithHistory} ${weekday}s con historial no hay ventas registradas: probablemente el negocio no abre ese día (o la captura estuvo caída). No armo recomendaciones para mañana.`,
      `La mayoría de los últimos ${weekday}s no tiene ventas. Si mañana sí se abre, verificá que la captura esté conectada.`,
    );
  }
  if (valid.length < MIN_VALID_DAYS) {
    return empty(
      "insufficient_history",
      `Solo hay ${valid.length} ${weekday}(s) con ventas en las últimas ${REFERENCE_WEEKS} semanas; necesito al menos ${MIN_VALID_DAYS} para estimar mañana. No armo recomendaciones.`,
      "Historial insuficiente para el pronóstico de mañana.",
    );
  }

  // Pronóstico baseline: percentiles de las ventas de los mismos días de la semana (sin ajuste de tendencia).
  const daily = valid.map((day) => dayTotals(rows, day, agentId));
  const sales = daily.map((d) => d.sales);
  const forecastSales = {
    low: round(quantile(sales, 0.25) ?? 0, 0),
    median: round(median(sales) ?? 0, 0),
    high: round(quantile(sales, 0.75) ?? 0, 0),
  };
  const forecastTickets = median(daily.map((d) => d.tickets));
  const confidence = confidenceFor(valid.length);

  // Perfil por hora: venta típica de cada hora en los días válidos.
  const hourValues: number[][] = Array.from({ length: 24 }, () => []);
  for (const day of valid) {
    const perHour = new Array<number>(24).fill(0);
    for (const row of rows) {
      if (row.day !== day || (agentId !== undefined && row.agentId !== agentId)) continue;
      perHour[Math.floor(row.slot / 2)] += row.sales;
    }
    perHour.forEach((value, hour) => hourValues[hour].push(value));
  }
  const profile = hourValues.map((values, hour) => ({
    hour,
    medianSales: median(values) ?? 0,
    activeDays: values.filter((v) => v > 0).length,
  }));
  const needed = Math.ceil(valid.length / 2);
  const activeHours = profile.filter((p) => p.activeDays >= needed && p.medianSales > 0);
  const hourlyProfile: HourProfile[] = activeHours.map((p) => ({ hour: hourLabel(p.hour), medianSales: round(p.medianSales), activeDays: p.activeDays }));

  // Productos: promedio por día válido de los mismos días de la semana.
  const aggregates = products ? aggregate(products.rows).filter((a) => a.units > 0) : [];
  const totalUnits = aggregates.reduce((sum, a) => sum + a.units, 0);
  const topProducts = aggregates
    .sort((a, b) => b.units - a.units || displayName(a).localeCompare(displayName(b)))
    .slice(0, 5)
    .map((a) => ({
      name: displayName(a),
      unitsPerDay: round(a.units / valid.length, 1),
      sharePctOfUnits: totalUnits > 0 ? round((a.units / totalUnits) * 100, 1) : null,
    }));

  const recommendations: Recommendation[] = [];
  const noMargin = { available: false as const, reason: "no hay costes cargados" };
  const common = { branch: branch?.label ?? null, day: tomorrow };

  // 1) Franja débil: solo horas interiores (la primera y la última hora activa son rampa de apertura/cierre).
  if (activeHours.length >= 4) {
    const typical = median(activeHours.map((p) => p.medianSales)) ?? 0;
    const first = activeHours[0].hour;
    const last = activeHours[activeHours.length - 1].hour;
    const weak = activeHours.filter((p) => p.hour > first && p.hour < last && p.medianSales < WEAK_RATIO * typical);
    const windows: Array<typeof weak> = [];
    for (const p of weak) {
      const current = windows[windows.length - 1];
      if (current && current[current.length - 1].hour === p.hour - 1) current.push(p);
      else windows.push([p]);
    }
    const gapOf = (w: typeof weak) => w.reduce((sum, p) => sum + (typical - p.medianSales), 0);
    const best = windows.sort((a, b) => gapOf(b) - gapOf(a))[0];
    if (best && typical > 0) {
      const gap = gapOf(best);
      const range = hourRange(best[0].hour, best[best.length - 1].hour);
      const windowMedian = best.reduce((sum, p) => sum + p.medianSales, 0) / best.length;
      recommendations.push({
        id: "weak_slot",
        kind: "weak_slot",
        priority: 0,
        what: `Probá una acción comercial en la franja de ${range} (por ejemplo un combo o un aviso a clientes habituales). Definila vos: no hay costes cargados, así que no recomiendo descuentos hasta validar el margen.`,
        why: `En los últimos ${valid.length} ${weekday}s esa franja vende en mediana ${formatAmount(round(windowMedian), currency)} por hora, menos de la mitad de una hora típica del día (${formatAmount(round(typical), currency)}).`,
        where: { ...common, hours: range, product: null },
        impact: {
          available: true,
          revenue: { low: round(gap * RECOVERY_LOW, 0), high: round(gap * RECOVERY_HIGH, 0) },
          assumption: `Escenario: se recupera entre el ${RECOVERY_LOW * 100} % y el ${RECOVERY_HIGH * 100} % de la diferencia con una hora típica. Una venta baja no prueba que haya demanda sin atender.`,
          margin: noMargin,
        },
        confidence: "low",
        confidenceReason: "La baja venta en una franja puede ser falta de demanda y no un problema que una acción resuelva; el rango parte de un supuesto, no de un dato.",
        followUp: `Mañana al cierre compará las ventas de ${range} con la mediana habitual (${formatAmount(round(best.reduce((s, p) => s + p.medianSales, 0)), currency)} en total para esa franja) y anotá si hiciste la acción.`,
        evidenceRefs: ["breakdown:hourlyProfile"],
      });
    }
  }

  // 2) Proteger el producto líder de ese día de la semana. Sin inventario no se estima impacto.
  if (topProducts.length > 0) {
    const leader = topProducts[0];
    recommendations.push({
      id: "protect_leader",
      kind: "protect_leader",
      priority: 0,
      what: `Asegurá que ${leader.name} esté disponible durante toda la jornada de mañana (preparación y reposición a tiempo).`,
      why: `Los ${weekday}s es el producto que más unidades vende: ${formatInt(leader.unitsPerDay)} por día en promedio${leader.sharePctOfUnits === null ? "" : `, ${formatShare(leader.sharePctOfUnits)} de las unidades`}.`,
      where: { ...common, hours: null, product: leader.name },
      impact: { available: false, revenue: null, assumption: "No se puede cuantificar: no hay inventario ni señal de agotamiento, y que un producto deje de venderse no prueba que se haya agotado.", margin: noMargin },
      confidence: "medium",
      confidenceReason: `Se apoya en ${valid.length} ${weekday}s con ventas; no se conoce el stock real.`,
      followUp: `Mañana revisá si ${leader.name} se agotó en algún momento y cuántas unidades vendió frente a las ${formatInt(leader.unitsPerDay)} habituales.`,
      evidenceRefs: ["breakdown:topProducts"],
    });
  }

  // 3) Cubrir el pico: la hora de mayor venta típica.
  if (activeHours.length >= 3) {
    const peak = [...activeHours].sort((a, b) => b.medianSales - a.medianSales)[0];
    const totalMedian = activeHours.reduce((sum, p) => sum + p.medianSales, 0);
    const share = totalMedian > 0 ? round((peak.medianSales / totalMedian) * 100, 1) : null;
    const range = hourRange(peak.hour, peak.hour);
    recommendations.push({
      id: "peak_coverage",
      kind: "peak_coverage",
      priority: 0,
      what: `Tené personal y producto listos para el pico de ${range}, sin esperar a que se forme la fila.`,
      why: `Es la hora de mayor venta típica de los ${weekday}s (${formatAmount(round(peak.medianSales), currency)} en mediana${share === null ? "" : `, ${formatShare(share)} de la venta del día`}).`,
      where: { ...common, hours: range, product: null },
      impact: { available: false, revenue: null, assumption: "No se puede cuantificar: no hay datos de plantilla, tiempos de espera ni ventas perdidas.", margin: noMargin },
      confidence: confidence === "high" ? "medium" : "low",
      confidenceReason: `Se apoya en ${valid.length} ${weekday}s de referencia; no hay datos de capacidad.`,
      followUp: `Mañana compará las ventas de ${range} con la mediana habitual y anotá si hubo esperas o faltantes.`,
      evidenceRefs: ["breakdown:hourlyProfile"],
    });
  }

  // Prioridad: la acción cuantificada primero, luego por confianza (el orden de inserción ya es el de facilidad).
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => Number(b.impact.available) - Number(a.impact.available) || rank[a.confidence] - rank[b.confidence]);
  recommendations.splice(3);
  recommendations.forEach((rec, i) => (rec.priority = i + 1));

  // Potencial: solo la acción cuantificada. Las demás no se estiman, así que no hay suma que solape.
  const quantified = recommendations.filter((r) => r.impact.revenue);
  const potentialRevenue = quantified.length > 0 ? { low: quantified.reduce((s, r) => s + (r.impact.revenue?.low ?? 0), 0), high: quantified.reduce((s, r) => s + (r.impact.revenue?.high ?? 0), 0) } : null;

  // Calidad.
  warnings.push("Es un escenario, no una promesa: el pronóstico no ajusta por tendencia, festivos, clima ni promociones.");
  warnings.push("No hay costes cargados: no se calcula margen ni se recomiendan promociones con descuento.");
  warnings.push("No hay inventario, plantilla ni horarios de apertura: no se pueden inferir faltantes ni restricciones operativas.");
  warnings.push("No se evalúan ventas cruzadas todavía (requiere asociar líneas dentro de cada ticket).");
  if (closedDays > 0) warnings.push(`${closedDays} ${weekday}(s) de referencia no tienen ventas y se excluyeron (cierre o captura caída).`);
  if (excluded.length > closedDays) warnings.push("Parte de las semanas de referencia es anterior al inicio del historial.");
  if (valid.length < 4) warnings.push(`El pronóstico se apoya en ${valid.length} día(s); el ideal son 4 a 8.`);
  if (productsStatus === "failed") warnings.push("No se pudo consultar el detalle por producto: faltan las acciones de productos.");
  else if (!products || topProducts.length === 0) warnings.push("No hay ventas con detalle de producto en esos días: faltan las acciones de productos.");
  if (products?.truncated) warnings.push("Se evaluaron los productos de mayor venta; los de muy baja venta pueden faltar.");
  if (recommendations.length === 0) warnings.push("Con estos datos no hay una oportunidad respaldada por evidencia para mañana.");

  const insights: Insight[] = [
    {
      id: "forecast",
      kind: "estimated",
      headline: `Para mañana (${weekday} ${tomorrow}) lo habitual es entre ${formatAmount(forecastSales.low, currency)} y ${formatAmount(forecastSales.high, currency)} (mediana ${formatAmount(forecastSales.median, currency)}).`,
      evidenceRefs: ["metric:forecast"],
      confidence,
    },
  ];
  for (const rec of recommendations) {
    insights.push({ id: `rec_${rec.id}`, kind: rec.impact.available ? "estimated" : "observed", headline: rec.why, evidenceRefs: rec.evidenceRefs, confidence: rec.confidence });
  }

  const summary = [
    `Mañana es ${weekday} ${tomorrow}. Según los últimos ${valid.length} ${weekday}s, lo habitual es entre ${formatAmount(forecastSales.low, currency)} y ${formatAmount(forecastSales.high, currency)} (mediana ${formatAmount(forecastSales.median, currency)}).`,
    recommendations.length > 0
      ? `Acciones: ${recommendations.map((r) => `(${r.priority}) ${r.what}`).join(" ")}`
      : "Con estos datos no hay una oportunidad respaldada por evidencia para mañana.",
    potentialRevenue
      ? `El potencial de ${formatAmount(potentialRevenue.low, currency)} a ${formatAmount(potentialRevenue.high, currency)} cubre solo la acción de la franja débil y es un escenario, no una promesa; las demás no se cuantifican.`
      : "No hay un potencial cuantificable: es un escenario, no una promesa.",
  ].join(" ");

  return {
    intent: "increase_tomorrow_sales",
    context,
    quality: { status: valid.length < 4 || excluded.length > 0 ? "partial" : "complete", lastSaleAt: null, productCoveragePct: null, costCoveragePct: null, warnings },
    metrics: {
      status: "ok",
      tomorrow: { day: tomorrow, weekday },
      forecast: { sales: forecastSales, tickets: forecastTickets, avgTicket: forecastTickets ? averageTicket(median(sales) ?? 0, forecastTickets) : null, validDays: valid.length, confidence },
      referenceDays: { valid, excluded },
      potential: {
        revenue: potentialRevenue,
        note: "Solo la acción con impacto cuantificado aporta al potencial; las otras no se estiman. Es un escenario, no una promesa.",
      },
    },
    breakdowns: { hourlyProfile, topProducts },
    insights,
    recommendations,
    summary,
  };
}
