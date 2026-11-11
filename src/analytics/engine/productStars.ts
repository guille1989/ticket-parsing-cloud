import { pctChange, round } from "./compare.js";
import { formatAmount, formatInt, formatPct, formatShare } from "./format.js";
import { PRODUCT_ROW_LIMIT, productWindow } from "./productData.js";
import type { AnalysisResponse, Insight, ProductRow } from "./types.js";

/** Un % de crecimiento sobre muy pocas unidades es ruido (1 → 3 unidades = +200 %). */
export const MIN_UNITS_FOR_GROWTH = 10;
/** Crecimiento mínimo para etiquetar un producto como emergente. */
const EMERGING_FROM_PCT = 20;
const TOP_N = 10;

export type StarLabel = "billing_leader" | "popularity" | "emerging";

export interface ProductStat {
  name: string;
  revenue: number;
  units: number;
  /** % de los ingresos totales del negocio en el periodo (no solo del Top 10). */
  revenueSharePct: number | null;
  previousUnits: number;
  previousRevenue: number;
  /** null = producto sin base en el periodo anterior (nuevo) o sin unidades suficientes. */
  unitsGrowthPct: number | null;
  revenueGrowthPct: number | null;
  labels: StarLabel[];
}

export interface ProductStarsMetrics {
  days: number;
  totalRevenue: number;
  totalUnits: number;
  distinctProducts: number;
  /** Ingresos del Top 5 / ingresos totales × 100. */
  top5ConcentrationPct: number | null;
  /** No hay costes cargados: el margen y "el más rentable" no se calculan. */
  margin: { available: false; reason: string };
}

export interface ProductStarsBreakdowns {
  byRevenue: ProductStat[];
  byUnits: ProductStat[];
  byGrowth: ProductStat[];
  /** Vendieron en el periodo actual y nada en el anterior: crecimiento no calculable. */
  newProducts: ProductStat[];
}

/** Minúsculas, sin tildes ni signos, espacios colapsados: "CAFÉ  con leche." y "cafe con leche" son el mismo producto. */
export function normalizeProductName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface Aggregate {
  variants: Map<string, number>;
  revenue: number;
  units: number;
  previousRevenue: number;
  previousUnits: number;
}

/**
 * Une SOLO nombres idénticos tras normalizar. Una variante parecida ("CAFE C/L" vs "CAFE CON LECHE")
 * no se une automáticamente: sin catálogo ni validación no hay forma de saber si es el mismo producto.
 */
export function aggregate(rows: ProductRow[]): Aggregate[] {
  const byKey = new Map<string, Aggregate>();
  for (const row of rows) {
    const key = normalizeProductName(row.description) || "(sin dato)";
    let entry = byKey.get(key);
    if (!entry) {
      entry = { variants: new Map(), revenue: 0, units: 0, previousRevenue: 0, previousUnits: 0 };
      byKey.set(key, entry);
    }
    entry.variants.set(row.description, (entry.variants.get(row.description) ?? 0) + Math.abs(row.revenue));
    if (row.period === "current") {
      entry.revenue += row.revenue;
      entry.units += row.units;
    } else {
      entry.previousRevenue += row.revenue;
      entry.previousUnits += row.units;
    }
  }
  return [...byKey.values()];
}

export function displayName(entry: Aggregate): string {
  return [...entry.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export interface ProductStarsInput {
  rows: ProductRow[];
  now: Date;
  timeZone: string;
  currency: string | null;
  days: number;
  branchLabel?: string;
  /** La consulta llegó al tope de filas: el ranking puede dejar fuera productos de baja venta. */
  truncated?: boolean;
}

export function buildProductStars(input: ProductStarsInput): AnalysisResponse<ProductStarsMetrics, ProductStarsBreakdowns> {
  const { rows, now, timeZone, currency, days, branchLabel } = input;
  const window = productWindow(now, timeZone, days);
  const aggregates = aggregate(rows).filter((entry) => entry.revenue !== 0 || entry.units !== 0 || entry.previousUnits !== 0);

  const totalRevenue = round(aggregates.reduce((sum, entry) => sum + entry.revenue, 0));
  const totalUnits = round(aggregates.reduce((sum, entry) => sum + entry.units, 0));
  const previousTotal = aggregates.reduce((sum, entry) => sum + entry.previousUnits, 0);

  const stats: ProductStat[] = aggregates
    .filter((entry) => entry.revenue > 0 || entry.units > 0)
    .map((entry) => {
      const enoughVolume = entry.previousUnits > 0 && entry.previousUnits + entry.units >= MIN_UNITS_FOR_GROWTH;
      return {
        name: displayName(entry),
        revenue: round(entry.revenue),
        units: round(entry.units),
        revenueSharePct: totalRevenue > 0 ? round((entry.revenue / totalRevenue) * 100, 1) : null,
        previousUnits: round(entry.previousUnits),
        previousRevenue: round(entry.previousRevenue),
        unitsGrowthPct: enoughVolume ? pctChange(entry.units, entry.previousUnits) : null,
        revenueGrowthPct: entry.previousRevenue > 0 ? pctChange(entry.revenue, entry.previousRevenue) : null,
        labels: [] as StarLabel[],
      };
    });

  const byName = (a: ProductStat, b: ProductStat) => a.name.localeCompare(b.name);
  const byRevenue = [...stats].sort((a, b) => b.revenue - a.revenue || byName(a, b));
  const byUnits = [...stats].sort((a, b) => b.units - a.units || byName(a, b));
  const byGrowth = stats
    .filter((s) => s.unitsGrowthPct !== null)
    .sort((a, b) => (b.unitsGrowthPct as number) - (a.unitsGrowthPct as number) || byName(a, b));
  const newProducts = stats.filter((s) => s.previousUnits === 0 && s.previousRevenue === 0).sort((a, b) => b.revenue - a.revenue || byName(a, b)).slice(0, 5);

  const revenueLeader = byRevenue[0];
  const unitsLeader = byUnits[0];
  const growthLeader = byGrowth[0] && (byGrowth[0].unitsGrowthPct as number) >= EMERGING_FROM_PCT ? byGrowth[0] : undefined;
  if (revenueLeader) revenueLeader.labels.push("billing_leader");
  if (unitsLeader && !unitsLeader.labels.includes("popularity")) unitsLeader.labels.push("popularity");
  if (growthLeader && !growthLeader.labels.includes("emerging")) growthLeader.labels.push("emerging");

  const top5Revenue = byRevenue.slice(0, 5).reduce((sum, s) => sum + s.revenue, 0);
  const top5ConcentrationPct = totalRevenue > 0 ? round((top5Revenue / totalRevenue) * 100, 1) : null;

  const warnings: string[] = [
    "No se dispone de costes: no se calcula margen ni cuál producto es el más rentable (solo cuál se vende más).",
    "Los productos se unen solo si el nombre coincide (sin distinguir mayúsculas ni tildes); las variantes de nombre se cuentan por separado.",
  ];
  if (input.truncated) warnings.push(`Se evaluaron los ${PRODUCT_ROW_LIMIT} registros de mayor venta; productos de muy baja venta pueden faltar.`);
  if (previousTotal === 0 && stats.length > 0) warnings.push("No hay ventas por producto en el periodo anterior: no se calcula crecimiento.");

  const insights: Insight[] = [];
  if (revenueLeader) {
    insights.push({
      id: "revenue_leader",
      kind: "observed",
      headline: `${revenueLeader.name} lidera la facturación con ${formatAmount(revenueLeader.revenue, currency)} (${revenueLeader.revenueSharePct === null ? "" : `${formatShare(revenueLeader.revenueSharePct)} de los ingresos`}).`,
      evidenceRefs: ["ranking:byRevenue"],
      confidence: "high",
    });
  }
  if (unitsLeader && unitsLeader !== revenueLeader) {
    insights.push({
      id: "units_leader",
      kind: "observed",
      headline: `${unitsLeader.name} es el más vendido en unidades (${formatInt(unitsLeader.units)}), distinto del líder de facturación.`,
      evidenceRefs: ["ranking:byUnits"],
      confidence: "high",
    });
  }
  if (growthLeader) {
    insights.push({
      id: "growth_leader",
      kind: "observed",
      headline: `${growthLeader.name} es el de mayor crecimiento en unidades (${formatPct(growthLeader.unitsGrowthPct)}) frente a los ${days} días anteriores.`,
      evidenceRefs: ["ranking:byGrowth"],
      confidence: "medium",
    });
  }

  const noData = stats.length === 0;
  const summary = noData
    ? `No hay ventas con detalle de producto entre ${window.currentFrom} y ${window.currentTo}: no puedo armar el ranking de productos.`
    : [
        `Entre ${window.currentFrom} y ${window.currentTo} (${days} días completos${branchLabel ? `, ${branchLabel}` : ""}):`,
        `${revenueLeader.name} lidera la facturación (${formatAmount(revenueLeader.revenue, currency)}).`,
        unitsLeader !== revenueLeader ? `El más vendido en unidades es ${unitsLeader.name} (${formatInt(unitsLeader.units)} uds.).` : `También es el más vendido en unidades (${formatInt(unitsLeader.units)} uds.).`,
        growthLeader ? `El de mayor crecimiento en unidades es ${growthLeader.name} (${formatPct(growthLeader.unitsGrowthPct)}).` : "No hay un producto con crecimiento claro frente al periodo anterior.",
        top5ConcentrationPct === null ? "" : `El Top 5 concentra el ${formatShare(top5ConcentrationPct)} de los ingresos.`,
        "No hay costes cargados, así que no puedo decir cuál es el más rentable.",
      ]
        .filter(Boolean)
        .join(" ");

  return {
    intent: "product_stars",
    context: {
      timezone: timeZone,
      currency,
      startDay: window.currentFrom,
      endDay: window.currentTo,
      cutoffLocal: null,
      comparison: `${days} días completos frente a los ${days} anteriores (${window.previousFrom} a ${window.previousTo})`,
      branch: branchLabel ?? null,
    },
    quality: {
      status: noData ? "no_data" : previousTotal === 0 ? "partial" : "complete",
      lastSaleAt: null,
      productCoveragePct: null,
      costCoveragePct: null,
      warnings,
    },
    metrics: {
      days,
      totalRevenue,
      totalUnits,
      distinctProducts: stats.length,
      top5ConcentrationPct,
      margin: { available: false, reason: "no se dispone de costes suficientes" },
    },
    breakdowns: {
      byRevenue: byRevenue.slice(0, TOP_N),
      byUnits: byUnits.slice(0, TOP_N),
      byGrowth: byGrowth.slice(0, 5),
      newProducts,
    },
    insights,
    recommendations: [],
    summary,
  };
}
