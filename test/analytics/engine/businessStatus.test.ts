import { buildBusinessStatus } from "../../../src/analytics/engine/businessStatus";
import { LAST_TUESDAY, NOW, TODAY, TZ, row, tuesday } from "./fixtures";

const labels = new Map([
  ["centro", "Centro"],
  ["norte", "Norte"],
]);

const history = [
  ...tuesday(LAST_TUESDAY, "a1", { sales: 1100, tickets: 175 }),
  ...tuesday("2026-10-27", "a1", { sales: 1000, tickets: 170 }),
  ...tuesday("2026-10-20", "a1", { sales: 1050, tickets: 172 }),
  ...tuesday("2026-10-13", "a1", { sales: 980, tickets: 168 }),
];

const twoBranches = [
  ...tuesday(LAST_TUESDAY, "centro", { sales: 690, tickets: 100 }),
  ...tuesday(LAST_TUESDAY, "norte", { sales: 410, tickets: 75 }),
  ...tuesday(TODAY, "centro", { sales: 780, tickets: 110 }),
  ...tuesday(TODAY, "norte", { sales: 468, tickets: 76 }),
];

describe("buildBusinessStatus", () => {
  it("reproduce el ejemplo del documento: +13,45 % ventas, +6,29 % tickets, ticket medio 6,71", () => {
    // Las ventas de la tarde (16:00) están después del corte y no deben contar.
    const rows = [...history, ...tuesday(TODAY, "a1", { sales: 1248, tickets: 186 }, { sales: 999, tickets: 99 })];
    const result = buildBusinessStatus({ rows, now: NOW, timeZone: TZ, currency: "COP", branchLabels: labels });

    expect(result.metrics.sales).toBe(1248);
    expect(result.metrics.tickets).toBe(186);
    expect(result.metrics.avgTicket).toBe(6.71);
    expect(result.metrics.reference).toMatchObject({ basis: "same_weekday_last_week", sales: 1100, tickets: 175 });
    expect(result.metrics.variation.salesPct).toBeCloseTo(13.45, 2);
    expect(result.metrics.variation.ticketsPct).toBeCloseTo(6.29, 2);
    expect(result.metrics.diagnosis).toBe("positive");
    expect(result.context).toMatchObject({ cutoffLocal: "15:30", timezone: TZ, branch: null, comparison: expect.stringContaining("misma franja horaria") });
    expect(result.metrics.goalProgress).toBeNull();
    expect(result.quality.costCoveragePct).toBeNull();
    expect(result.quality.status).toBe("complete");
    expect(result.quality.warnings.join(" ")).toContain("No hay objetivo diario");
    expect(result.recommendations).toEqual([]);
  });

  it("el resumen determinista trae la cifra, la hora de corte y el factor dominante", () => {
    const rows = [...history, ...tuesday(TODAY, "a1", { sales: 1248, tickets: 186 })];
    const { summary, metrics } = buildBusinessStatus({ rows, now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    expect(summary).toContain("1.248");
    expect(summary).toContain("15:30");
    expect(summary).toContain("186");
    // (186−175)×6,29 = +69 por tickets; 186×(6,71−6,29) = +79 por ticket medio; suman la variación de +148.
    expect(metrics.decomposition).toMatchObject({ delta: 148 });
    expect((metrics.decomposition?.ticketsEffect ?? 0) + (metrics.decomposition?.avgTicketEffect ?? 0)).toBeCloseTo(148, 1);
    expect(metrics.dominantDriver).toBe("avg_ticket");
    expect(summary).toContain("ticket medio");
    expect(summary).not.toContain("COP");
  });

  it("si el mismo día de la semana pasada estuvo cerrado, usa la mediana y lo avisa", () => {
    const rows = [...history.filter((r) => r.day !== LAST_TUESDAY), ...tuesday(TODAY, "a1", { sales: 1000, tickets: 170 })];
    const result = buildBusinessStatus({ rows, now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.metrics.reference.basis).toBe("median_of_same_weekdays");
    expect(result.metrics.reference.excluded[0].day).toBe(LAST_TUESDAY);
    expect(result.quality.warnings.join(" ")).toContain("mediana");
  });

  it("referencia en cero: variación null y 'sin base comparable', no infinito", () => {
    // La semana pasada solo vendió después del corte.
    const rows = [row(LAST_TUESDAY, 40, "a1", 500, 50), row(TODAY, 20, "a1", 300, 30)];
    const result = buildBusinessStatus({ rows, now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.metrics.reference.sales).toBe(0);
    expect(result.metrics.variation.salesPct).toBeNull();
    expect(result.metrics.diagnosis).toBe("no_comparison");
    expect(result.summary).toContain("No hay una base comparable");
  });

  it("sin tickets hoy: 'sin transacciones observadas', pide revisar la captura y no concluye", () => {
    const result = buildBusinessStatus({ rows: history, now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.metrics.diagnosis).toBe("no_data");
    expect(result.metrics.avgTicket).toBeNull();
    expect(result.quality.status).toBe("no_data");
    expect(result.summary).toContain("Sin transacciones observadas");
    expect(result.summary).toContain("captura");
  });

  it("sin historial no hay base: calidad parcial, variación null", () => {
    const result = buildBusinessStatus({ rows: [row(TODAY, 20, "a1", 300, 30)], now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.metrics.reference.basis).toBe("none");
    expect(result.metrics.variation.salesPct).toBeNull();
    expect(result.quality.status).toBe("partial");
  });

  it("muy temprano (ninguna franja cerrada): no compara", () => {
    const result = buildBusinessStatus({ rows: history, now: new Date("2026-11-10T05:10:00Z"), timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.context.cutoffLocal).toBeNull();
    expect(result.summary).toContain("muy temprano");
  });

  it("desglose por sucursal: reconcilia con el total (780+468 = 1.248 vs 690+410 = 1.100)", () => {
    const result = buildBusinessStatus({ rows: twoBranches, now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    const [centro, norte] = result.breakdowns.byBranch;
    expect(centro).toMatchObject({ branch: "Centro", sales: 780, referenceSales: 690 });
    expect(norte).toMatchObject({ branch: "Norte", sales: 468, referenceSales: 410 });
    expect(centro.salesPct).toBeCloseTo(13.04, 2);
    expect(norte.salesPct).toBeCloseTo(14.15, 2);
    expect(centro.sales + norte.sales).toBe(result.metrics.sales);
    expect((centro.referenceSales as number) + (norte.referenceSales as number)).toBe(result.metrics.reference.sales);
  });

  it("una sucursal sin ventas hoy que sí vendía a esta hora genera un aviso de captura", () => {
    const rows = twoBranches.filter((r) => !(r.agentId === "norte" && r.day === TODAY));
    const result = buildBusinessStatus({ rows, now: NOW, timeZone: TZ, currency: null, branchLabels: labels });
    const silent = result.insights.find((i) => i.id.startsWith("silent_"));
    expect(silent?.headline).toContain("Norte");
    expect(silent?.headline).toContain("captura");
  });

  it("filtrada por sucursal solo cuenta esa sucursal y no desglosa", () => {
    const result = buildBusinessStatus({
      rows: twoBranches,
      now: NOW,
      timeZone: TZ,
      currency: null,
      branchLabels: labels,
      branch: { agentId: "norte", label: "Norte" },
    });
    expect(result.metrics.sales).toBe(468);
    expect(result.metrics.reference.sales).toBe(410);
    expect(result.breakdowns.byBranch).toEqual([]);
    expect(result.context.branch).toBe("Norte");
  });
});
