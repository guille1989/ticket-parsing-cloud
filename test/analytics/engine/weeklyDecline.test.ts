import { buildWeeklyDecline, closedWeekProductWindow, weekStart } from "../../../src/analytics/engine/weeklyDecline";
import type { ProductRow, SalesSlotRow } from "../../../src/analytics/engine/types";
import { NOW, TZ, row } from "./fixtures";

// NOW = martes 2026-11-10 15:40 en Bogotá → corte a las 15:30. Semana en curso: lunes 11-09 y martes 11-10;
// referencia: lunes 11-02 y martes 11-03. Todo lo que cae en la franja 40 (20:00) queda después del corte de hoy.
const MON = "2026-11-09";
const TUE = "2026-11-10";
const REF_MON = "2026-11-02";
const REF_TUE = "2026-11-03";

const labels = new Map([
  ["centro", "Centro"],
  ["norte", "Norte"],
]);

/**
 * Cifras del documento: 4.500 vs 5.000 (−10 %), tickets 600 vs 625, ticket medio 7,50 vs 8,00.
 * Centro: 2.700 vs 2.600 (+100). Norte: 1.800 vs 2.400 (−600). Suman −500.
 */
const rows: SalesSlotRow[] = [
  row(MON, 20, "centro", 1200, 150),
  row(MON, 20, "norte", 800, 100),
  row(TUE, 20, "centro", 1500, 200),
  row(TUE, 20, "norte", 1000, 150),
  row(TUE, 40, "centro", 999, 99), // después del corte de hoy: no cuenta
  row(REF_MON, 20, "centro", 1300, 150),
  row(REF_MON, 20, "norte", 1200, 150),
  row(REF_TUE, 20, "centro", 1300, 160),
  row(REF_TUE, 20, "norte", 1200, 165),
  row(REF_TUE, 40, "norte", 800, 80), // después del corte: no cuenta en la referencia
];

const prod = (description: string, period: "current" | "previous", revenue: number, units: number): ProductRow => ({ description, period, revenue, units });
const productRows: ProductRow[] = [
  prod("CAFE", "current", 1200, 480),
  prod("PAN", "current", 700, 100),
  prod("CAFE", "previous", 1500, 500),
  prod("PAN", "previous", 800, 100),
];
const window = closedWeekProductWindow(NOW, TZ)!;

const run = (overrides: Partial<Parameters<typeof buildWeeklyDecline>[0]> = {}) =>
  buildWeeklyDecline({ rows, now: NOW, timeZone: TZ, currency: null, branchLabels: labels, products: { rows: productRows, window }, ...overrides });

describe("buildWeeklyDecline", () => {
  it("reproduce el ejemplo del documento: −10 %, tickets −4 %, ticket medio −6,25 %, efectos −200 y −300", () => {
    const { metrics } = run();
    expect(metrics.status).toBe("decline");
    expect(metrics.current).toMatchObject({ sales: 4500, tickets: 600, avgTicket: 7.5 });
    expect(metrics.reference).toMatchObject({ sales: 5000, tickets: 625, avgTicket: 8 });
    expect(metrics.delta).toBe(-500);
    expect(metrics.variation).toEqual({ salesPct: -10, ticketsPct: -4, avgTicketPct: -6.25 });
    expect(metrics.accounting).toEqual({ delta: -500, ticketsEffect: -200, avgTicketEffect: -300 });
    expect(metrics.window).toEqual({ currentFrom: MON, currentTo: TUE, referenceFrom: REF_MON, referenceTo: REF_TUE, cutoffLocal: "15:30" });
  });

  it("la semana parcial se compara con la misma franja, no con la semana completa", () => {
    const { metrics } = run();
    // Si contara la tarde de hoy o la de la semana pasada, las cifras serían otras.
    expect(metrics.current.sales).toBe(4500);
    expect(metrics.reference.sales).toBe(5000);
  });

  it("las sucursales reconcilian con la variación total y ordenan de mayor caída a mayor alza", () => {
    const { breakdowns, metrics } = run();
    expect(breakdowns.byBranch.map((b) => [b.label, b.delta])).toEqual([
      ["Norte", -600],
      ["Centro", 100],
    ]);
    expect(breakdowns.byBranch.reduce((sum, b) => sum + b.delta, 0)).toBe(metrics.delta);
    expect(breakdowns.byBranch[0].pct).toBe(-25);
  });

  it("las horas y los días también reconcilian con el total", () => {
    const { breakdowns, metrics } = run();
    expect(breakdowns.byHour).toHaveLength(1);
    expect(breakdowns.byHour[0]).toMatchObject({ label: "10:00", delta: -500 });
    expect(breakdowns.byDay.map((d) => [d.label, d.referenceDay, d.delta])).toEqual([
      [MON, REF_MON, -500],
      [TUE, REF_TUE, 0],
    ]);
    expect(breakdowns.byDay.reduce((sum, d) => sum + d.delta, 0)).toBe(metrics.delta);
  });

  it("por producto: Δ ingresos, Δ unidades y precio realizado, ordenados por mayor caída", () => {
    const { breakdowns, quality } = run();
    const [cafe, pan] = breakdowns.byProduct!;
    expect(cafe).toMatchObject({ name: "CAFE", revenueDelta: -300, unitsDelta: -20, currentPrice: 2.5, referencePrice: 3 });
    expect(cafe.pricePct).toBeCloseTo(-16.67, 2);
    expect(pan).toMatchObject({ name: "PAN", revenueDelta: -100, unitsDelta: 0 });
    expect(quality.productCoveragePct).toBeGreaterThanOrEqual(60);
  });

  it("los tres factores de mayor caída son de dimensiones distintas y se avisa que no se suman", () => {
    const { breakdowns, summary } = run();
    expect(breakdowns.topDrivers.length).toBeLessThanOrEqual(3);
    expect(new Set(breakdowns.topDrivers.map((d) => d.dimension)).size).toBe(breakdowns.topDrivers.length);
    expect(breakdowns.topDrivers[0]).toEqual({ dimension: "branch", label: "Norte", delta: -600 });
    expect(summary).toContain("no se suman");
    expect(summary).toContain("aún no está confirmado");
  });

  it("separa hechos observados de hipótesis, y la hipótesis no afirma causas", () => {
    const { insights } = run();
    const hypothesis = insights.find((i) => i.kind === "hypothesis");
    expect(hypothesis?.headline).toContain("no está confirmado");
    expect(hypothesis?.confidence).toBe("low");
    expect(insights.filter((i) => i.kind === "observed").length).toBeGreaterThan(1);
  });

  it("si la semana creció no hay caída: responde 'no se observa una caída comparable' y sin factores de caída", () => {
    const grown = rows.map((r) => (r.day === MON || r.day === TUE ? { ...r, sales: r.sales * 1.5 } : r));
    const result = run({ rows: grown });
    expect(result.metrics.status).toBe("no_decline");
    expect(result.summary.startsWith("No se observa una caída comparable")).toBe(true);
    expect(result.breakdowns.topDrivers).toEqual([]);
    expect(result.insights.some((i) => i.kind === "hypothesis")).toBe(false);
  });

  it("referencia en cero: porcentaje null y 'sin base comparable'", () => {
    const result = run({ rows: rows.filter((r) => r.day === MON || r.day === TUE) });
    expect(result.metrics.status).toBe("no_comparison");
    expect(result.metrics.variation.salesPct).toBeNull();
    expect(result.metrics.accounting).toBeNull();
    expect(result.summary).toContain("no hay base comparable");
  });

  it("un día cerrado sin ventas se marca como cobertura y no se presenta como causa de la caída", () => {
    const withoutMonday = rows.filter((r) => r.day !== MON);
    const result = run({ rows: withoutMonday });
    const monday = result.breakdowns.byDay.find((d) => d.label === MON)!;
    expect(monday.notes.join(" ")).toContain("cierre o captura caída");
    expect(result.quality.warnings.join(" ")).toContain("cobertura");
    expect(result.breakdowns.topDrivers.some((d) => d.dimension === "day" && d.label === MON)).toBe(false);
  });

  it("cobertura de productos insuficiente: no atribuye a productos y lo dice", () => {
    const thin = [prod("CAFE", "current", 50, 20), prod("CAFE", "previous", 60, 20)];
    const result = run({ products: { rows: thin, window } });
    expect(result.breakdowns.byProduct).toBeNull();
    expect(result.quality.warnings.join(" ")).toContain("no se atribuye la variación a productos");
    expect(result.breakdowns.topDrivers.some((d) => d.dimension === "product")).toBe(false);
  });

  it("si la consulta de productos falla, el resto del análisis sigue y se avisa", () => {
    const result = run({ products: undefined, productsStatus: "failed" });
    expect(result.metrics.status).toBe("decline");
    expect(result.breakdowns.byProduct).toBeNull();
    expect(result.quality.warnings.join(" ")).toContain("No se pudo consultar el detalle por producto");
  });

  it("el lunes: la ventana es solo hoy, sin días cerrados para productos", () => {
    const monday = new Date("2026-11-09T20:40:00Z");
    expect(closedWeekProductWindow(monday, TZ)).toBeNull();
    const result = buildWeeklyDecline({ rows, now: monday, timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.context).toMatchObject({ startDay: MON, endDay: MON });
    expect(result.metrics.window.referenceFrom).toBe(REF_MON);
    expect(result.quality.warnings.join(" ")).toContain("primer día de la semana");
  });

  it("el lunes antes de que cierre una franja no compara", () => {
    const result = buildWeeklyDecline({ rows, now: new Date("2026-11-09T05:10:00Z"), timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.metrics.status).toBe("no_data");
    expect(result.summary).toContain("muy temprano");
  });

  it("filtrada por sucursal solo cuenta esa sucursal y no desglosa por sucursal", () => {
    const result = run({ branch: { agentId: "norte", label: "Norte" } });
    expect(result.metrics.current.sales).toBe(1800);
    expect(result.metrics.reference.sales).toBe(2400);
    expect(result.breakdowns.byBranch).toEqual([]);
    expect(result.context.branch).toBe("Norte");
  });

  it("no promete causas: avisa que faltan promociones, precios, stock, festivos, personal y clima", () => {
    expect(run().quality.warnings.join(" ")).toContain("las causas comerciales no se pueden confirmar");
  });
});

describe("semana y ventana de productos", () => {
  it("la semana empieza el lunes", () => {
    expect(weekStart("2026-11-10")).toBe("2026-11-09");
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
    expect(weekStart("2026-11-15")).toBe("2026-11-09");
  });

  it("los productos cubren los días cerrados de ambas semanas, desde el mismo lunes hasta ayer", () => {
    expect(window).toEqual({ currentFrom: MON, currentTo: MON, previousFrom: REF_MON, previousTo: REF_MON });
  });

  it("semana pasada (last_closed) = lun–dom ISO cerrados, no el parcial lun→hoy", () => {
    // NOW = martes 2026-11-10 → last_closed = 2026-11-02 … 2026-11-08; referencia = 2026-10-26 … 2026-11-01.
    const LAST_SUN = "2026-11-08";
    const PREV_MON = "2026-10-26";
    const PREV_SUN = "2026-11-01";
    expect(closedWeekProductWindow(NOW, TZ, "last_closed")).toEqual({
      currentFrom: REF_MON,
      currentTo: LAST_SUN,
      previousFrom: PREV_MON,
      previousTo: PREV_SUN,
    });

    const closedRows: SalesSlotRow[] = [
      row(REF_MON, 20, "centro", 1000, 100),
      row("2026-11-03", 20, "centro", 900, 90),
      row("2026-11-04", 20, "centro", 800, 80),
      row("2026-11-05", 20, "centro", 700, 70),
      row("2026-11-06", 20, "centro", 600, 60),
      row("2026-11-07", 20, "centro", 500, 50),
      row(LAST_SUN, 20, "centro", 400, 40),
      row(PREV_MON, 20, "centro", 1100, 110),
      row("2026-10-27", 20, "centro", 1000, 100),
      row("2026-10-28", 20, "centro", 900, 90),
      row("2026-10-29", 20, "centro", 800, 80),
      row("2026-10-30", 20, "centro", 700, 70),
      row("2026-10-31", 20, "centro", 600, 60),
      row(PREV_SUN, 20, "centro", 500, 50),
      // parcial de la semana en curso: no debe entrar en last_closed
      row(MON, 20, "centro", 9999, 999),
      row(TUE, 20, "centro", 9999, 999),
    ];
    const result = buildWeeklyDecline({
      rows: closedRows,
      now: NOW,
      timeZone: TZ,
      currency: null,
      branchLabels: labels,
      week: "last_closed",
    });
    expect(result.metrics.window).toEqual({
      currentFrom: REF_MON,
      currentTo: LAST_SUN,
      referenceFrom: PREV_MON,
      referenceTo: PREV_SUN,
      cutoffLocal: null,
    });
    expect(result.context).toMatchObject({ startDay: REF_MON, endDay: LAST_SUN, cutoffLocal: null });
    expect(result.metrics.current.sales).toBe(4900);
    expect(result.metrics.reference.sales).toBe(5600);
    expect(result.summary).toContain("semana pasada");
    expect(result.summary).not.toContain("hasta el 2026-11-10");
    expect(result.quality.warnings.join(" ")).toContain("semana ISO cerrada");
  });
});
