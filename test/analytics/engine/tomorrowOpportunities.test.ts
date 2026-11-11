import { buildTomorrowOpportunities, tomorrowReferenceDates } from "../../../src/analytics/engine/tomorrowOpportunities";
import { buildProductDatesQuery } from "../../../src/analytics/engine/productData";
import { quantile } from "../../../src/analytics/engine/compare";
import type { ProductRow, SalesSlotRow } from "../../../src/analytics/engine/types";
import { NOW, TZ, row } from "./fixtures";

// NOW = martes 2026-11-10 → mañana es el miércoles 2026-11-11. Los 8 miércoles de referencia son
// 11-04, 10-28, 10-21, 10-14, 10-07, 09-30, 09-23 y 09-16.
const WEDNESDAYS = ["2026-11-04", "2026-10-28", "2026-10-21", "2026-10-14", "2026-10-07", "2026-09-30", "2026-09-23", "2026-09-16"];

/** Ventas por hora de un miércoles típico: pico a las 12, hueco a las 13 y 14, rampa de apertura (8) y de cierre (17). */
const HOURLY: Record<number, number> = { 8: 100, 9: 400, 10: 500, 11: 600, 12: 900, 13: 150, 14: 100, 15: 500, 16: 400, 17: 100 };
const DAY_TOTAL = 3750;

function wednesday(day: string, agentId = "a1", factor = 1): SalesSlotRow[] {
  return Object.entries(HOURLY).map(([hour, sales]) => row(day, Number(hour) * 2, agentId, sales * factor, Math.round((sales * factor) / 10)));
}

/** Una venta suelta de un día anterior a todas las referencias: fija que el historial ya existía (sin ella, los días sin datos serían "antes del historial", no cierres). */
const anchor = row("2026-09-01", 20, "a1", 10, 1);

const fullHistory = [anchor, ...WEDNESDAYS.slice(0, 6).flatMap((day) => wednesday(day))];

const prod = (description: string, revenue: number, units: number): ProductRow => ({ description, period: "current", revenue, units });
const productRows = [prod("CAFE", 1500, 600), prod("PAN", 900, 300)];

const run = (overrides: Partial<Parameters<typeof buildTomorrowOpportunities>[0]> = {}) =>
  buildTomorrowOpportunities({ rows: fullHistory, now: NOW, timeZone: TZ, currency: null, products: { rows: productRows }, ...overrides });

describe("tomorrowReferenceDates", () => {
  it("mañana es el día local siguiente y las referencias son los 8 mismos días de la semana anteriores", () => {
    const { tomorrow, dates } = tomorrowReferenceDates(NOW, TZ);
    expect(tomorrow).toBe("2026-11-11");
    expect(dates).toEqual(WEDNESDAYS);
  });

  it("usa la fecha local: pasada la medianoche en Bogotá (05:30Z) mañana ya es el 12", () => {
    expect(tomorrowReferenceDates(new Date("2026-11-11T05:30:00Z"), TZ).tomorrow).toBe("2026-11-12");
    expect(tomorrowReferenceDates(new Date("2026-11-11T03:00:00Z"), TZ).tomorrow).toBe("2026-11-11");
  });
});

describe("buildTomorrowOpportunities", () => {
  it("pronostica con los percentiles de los mismos días de la semana y lo marca como estimado", () => {
    const { metrics, insights } = run();
    expect(metrics.status).toBe("ok");
    expect(metrics.tomorrow).toEqual({ day: "2026-11-11", weekday: "miércoles" });
    expect(metrics.forecast).toMatchObject({ sales: { low: DAY_TOTAL, median: DAY_TOTAL, high: DAY_TOTAL }, validDays: 6, confidence: "high" });
    expect(insights.find((i) => i.id === "forecast")?.kind).toBe("estimated");
  });

  it("el rango del pronóstico sale de los percentiles 25-75 de ventas diarias", () => {
    const factors = [0.8, 0.9, 1, 1, 1.1, 1.2];
    const rows = WEDNESDAYS.slice(0, 6).flatMap((day, i) => wednesday(day, "a1", factors[i]));
    const { forecast } = run({ rows }).metrics;
    const totals = factors.map((f) => DAY_TOTAL * f);
    expect(forecast?.sales.low).toBe(Math.round(quantile(totals, 0.25)!));
    expect(forecast?.sales.median).toBe(3750);
    expect(forecast?.sales.high).toBe(Math.round(quantile(totals, 0.75)!));
    expect(forecast!.sales.low).toBeLessThan(forecast!.sales.median);
  });

  it("devuelve hasta 3 acciones; la cuantificada va primero y todas traen los seis campos del documento", () => {
    const { recommendations } = run();
    expect(recommendations.map((r) => r.id)).toEqual(["weak_slot", "protect_leader", "peak_coverage"]);
    expect(recommendations.map((r) => r.priority)).toEqual([1, 2, 3]);
    for (const rec of recommendations) {
      expect(rec.what).toBeTruthy();
      expect(rec.why).toBeTruthy();
      expect(rec.where.day).toBe("2026-11-11");
      expect(rec.confidenceReason).toBeTruthy();
      expect(rec.followUp).toBeTruthy();
      expect(rec.evidenceRefs.length).toBeGreaterThan(0);
      expect(rec.impact.margin).toEqual({ available: false, reason: "no hay costes cargados" });
    }
  });

  it("franja débil: une las horas débiles contiguas, deja fuera la rampa de apertura/cierre y da un rango con su supuesto", () => {
    const weak = run().recommendations[0];
    // 13:00 y 14:00 venden 150 y 100, menos de la mitad de una hora típica (mediana 400). 8:00 y 17:00 valen 100 pero son la rampa.
    expect(weak.where.hours).toBe("13:00–15:00");
    expect(weak.impact.available).toBe(true);
    // Diferencia con la hora típica: (400−150) + (400−100) = 550 → entre el 10 % y el 25 %.
    expect(weak.impact.revenue).toEqual({ low: 55, high: 138 });
    expect(weak.impact.assumption).toContain("10 %");
    expect(weak.impact.assumption).toContain("no prueba");
    expect(weak.confidence).toBe("low");
    expect(weak.what).toContain("no recomiendo descuentos");
  });

  it("protege el producto líder del día sin inventar impacto ni stock", () => {
    const leader = run().recommendations[1];
    expect(leader.where.product).toBe("CAFE");
    expect(leader.impact).toMatchObject({ available: false, revenue: null });
    expect(leader.impact.assumption).toContain("no prueba que se haya agotado");
    expect(leader.why).toContain("100 por día");
  });

  it("cubre el pico: la hora de mayor venta típica, sin cuantificar", () => {
    const peak = run().recommendations[2];
    expect(peak.where.hours).toBe("12:00–13:00");
    expect(peak.why).toContain("24%");
    expect(peak.impact).toMatchObject({ available: false, revenue: null });
  });

  it("el potencial solo suma la acción cuantificada: no se suman impactos que se solapan", () => {
    const { metrics, recommendations } = run();
    expect(metrics.potential.revenue).toEqual(recommendations[0].impact.revenue);
    expect(metrics.potential.note).toContain("Solo la acción con impacto cuantificado");
  });

  it("el resumen es un escenario, no una promesa, y no habla de rentabilidad", () => {
    const { summary, quality } = run();
    expect(summary).toContain("escenario, no una promesa");
    expect(summary).not.toMatch(/rentable|vas a vender/);
    expect(quality.warnings.join(" ")).toContain("no ajusta por tendencia");
    expect(quality.warnings.join(" ")).toContain("No hay costes cargados");
    expect(quality.warnings.join(" ")).toContain("ventas cruzadas");
    expect(quality.costCoveragePct).toBeNull();
  });

  it("un perfil parejo no inventa una franja débil", () => {
    const flat = WEDNESDAYS.slice(0, 6).flatMap((day) => [8, 9, 10, 11, 12, 13].map((h) => row(day, h * 2, "a1", 300, 30)));
    const ids = run({ rows: flat }).recommendations.map((r) => r.id);
    expect(ids).not.toContain("weak_slot");
  });

  it("registra los días de referencia sin ventas como excluidos y baja la confianza", () => {
    const rows = [anchor, ...WEDNESDAYS.slice(0, 5).flatMap((day) => (day === WEDNESDAYS[2] ? [] : wednesday(day)))]; // 4 válidos, 1 cierre, 3 sin historial... el 6.º y siguientes tampoco tienen ventas
    const result = run({ rows });
    expect(result.metrics.referenceDays.valid).toHaveLength(4);
    expect(result.metrics.referenceDays.excluded).toHaveLength(4);
    expect(result.metrics.referenceDays.excluded[0].reason).toContain("sin ventas");
    expect(result.metrics.forecast?.confidence).toBe("medium");
    expect(result.quality.status).toBe("partial");
  });

  it("un negocio con poco historial (no un cierre) no pronostica ni recomienda", () => {
    // Solo hay datos desde el 10-21: los miércoles anteriores son "antes del historial", no cierres.
    const result = run({ rows: ["2026-10-28", "2026-11-04"].flatMap((day) => wednesday(day)) });
    expect(result.metrics.referenceDays.excluded.every((d) => d.reason.includes("anterior al inicio"))).toBe(true);
    expect(result.metrics.status).toBe("insufficient_history");
    expect(result.metrics.forecast).toBeNull();
    expect(result.recommendations).toEqual([]);
    expect(result.quality.status).toBe("no_data");
  });

  it("si la mayoría de los últimos mismos días no tuvo ventas, asume que ese día no abre", () => {
    const result = run({ rows: [anchor, ...WEDNESDAYS.slice(0, 3).flatMap((day) => wednesday(day))] });
    expect(result.metrics.status).toBe("likely_closed");
    expect(result.recommendations).toEqual([]);
    expect(result.summary).toContain("probablemente el negocio no abre");
  });

  it("si falla la consulta de productos, sigue con las acciones de horas y lo avisa", () => {
    const result = run({ products: undefined, productsStatus: "failed" });
    expect(result.recommendations.map((r) => r.id)).toEqual(["weak_slot", "peak_coverage"]);
    expect(result.quality.warnings.join(" ")).toContain("No se pudo consultar el detalle por producto");
  });

  it("sin detalle de producto en esos días lo dice en vez de inventar un líder", () => {
    const result = run({ products: { rows: [] } });
    expect(result.recommendations.some((r) => r.kind === "protect_leader")).toBe(false);
    expect(result.quality.warnings.join(" ")).toContain("No hay ventas con detalle de producto");
  });

  it("filtrada por sucursal usa solo las ventas de esa sucursal", () => {
    const rows = [...fullHistory, ...WEDNESDAYS.slice(0, 6).flatMap((day) => wednesday(day, "otra", 10))];
    const result = run({ rows, branch: { agentId: "a1", label: "Centro" } });
    expect(result.metrics.forecast?.sales.median).toBe(DAY_TOTAL);
    expect(result.context.branch).toBe("Centro");
    expect(result.recommendations[0].where.branch).toBe("Centro");
  });
});

describe("consulta de productos por fechas", () => {
  const { dates } = tomorrowReferenceDates(NOW, TZ);

  it("las fechas y el tenant viajan como parámetros, uno por cada ?", () => {
    const { sql, params } = buildProductDatesQuery("tenant-x", TZ, NOW, dates);
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params.slice(3)).toEqual(dates);
    expect(params[0]).toBe("tenant-x");
    expect(sql).not.toContain("tenant-x");
    expect(sql).toContain("COALESCE(voided, false) = false");
  });

  it("filtra por sucursal y valida zona y cantidad de fechas", () => {
    const query = buildProductDatesQuery("t1", TZ, NOW, dates, "agent-1");
    expect(query.sql).toContain("agentid = ?");
    expect(query.params[query.params.length - 1]).toBe("agent-1");
    expect(() => buildProductDatesQuery("t1", "America/Bogota'; DROP TABLE x --", NOW, dates)).toThrow("zona horaria inválida");
    expect(() => buildProductDatesQuery("t1", TZ, NOW, [])).toThrow("entre 1 y 20 fechas");
  });
});
