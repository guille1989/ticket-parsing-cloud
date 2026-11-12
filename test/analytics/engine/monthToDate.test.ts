import { buildMonthToDate } from "../../../src/analytics/engine/monthToDate";
import type { SalesSlotRow } from "../../../src/analytics/engine/types";
import { NOW, TZ, row } from "./fixtures";

// NOW = martes 2026-11-10 15:40 en Bogotá → corte a las 15:30 (franjas < 31).
// Este mes: 2026-11-01 a 2026-11-10. Referencia: 2026-10-01 a 2026-10-10 (mismo número de día, mismo corte).
const labels = new Map([
  ["centro", "Centro"],
  ["norte", "Norte"],
]);

const rows: SalesSlotRow[] = [
  row("2026-11-01", 20, "centro", 600, 60),
  row("2026-11-01", 20, "norte", 400, 40),
  row("2026-11-10", 20, "centro", 500, 50),
  row("2026-11-10", 40, "centro", 999, 99), // después del corte de hoy: no cuenta
  row("2026-10-01", 20, "centro", 500, 50),
  row("2026-10-01", 20, "norte", 300, 30),
  row("2026-10-10", 20, "norte", 400, 40),
  row("2026-10-10", 40, "norte", 777, 77), // después del corte en el mismo día de referencia: no cuenta
  row("2026-10-11", 20, "centro", 5000, 500), // fuera del tramo (día 11): no cuenta
  row("2026-09-30", 20, "centro", 5000, 500), // mes anterior al anterior: no cuenta
];

const run = (overrides: Partial<Parameters<typeof buildMonthToDate>[0]> = {}) =>
  buildMonthToDate({ rows, now: NOW, timeZone: TZ, currency: null, branchLabels: labels, ...overrides });

describe("buildMonthToDate", () => {
  it("compara el día 1 a hoy contra el día 1 al mismo número de día del mes anterior, con el mismo corte", () => {
    const result = run();
    expect(result.intent).toBe("month_to_date");
    expect(result.metrics.window).toMatchObject({
      currentFrom: "2026-11-01",
      currentTo: "2026-11-10",
      referenceFrom: "2026-10-01",
      referenceTo: "2026-10-10",
      referenceClamped: false,
    });
    expect(result.metrics.current).toMatchObject({ sales: 1500, tickets: 150, avgTicket: 10 });
    expect(result.metrics.reference).toMatchObject({ sales: 1200, tickets: 120, avgTicket: 10 });
    expect(result.metrics.delta).toBe(300);
    expect(result.metrics.variation.salesPct).toBe(25);
    expect(result.metrics.variation.ticketsPct).toBe(25);
    expect(result.metrics.status).toBe("ok");
  });

  it("los efectos de tickets y ticket medio suman la variación", () => {
    const { metrics } = run();
    expect(metrics.accounting).not.toBeNull();
    expect(metrics.accounting!.ticketsEffect + metrics.accounting!.avgTicketEffect).toBeCloseTo(metrics.delta, 2);
  });

  it("desglosa por sucursal y reconcilia con el total", () => {
    const { breakdowns, metrics } = run();
    expect(breakdowns.byBranch.map((b) => b.branch)).toEqual(["Centro", "Norte"]);
    expect(breakdowns.byBranch.reduce((sum, b) => sum + b.delta, 0)).toBeCloseTo(metrics.delta, 2);
    const centro = breakdowns.byBranch[0];
    expect(centro.current.sales).toBe(1100);
    expect(centro.reference.sales).toBe(500);
  });

  it("limita todo a una sucursal si se pide", () => {
    const { metrics, breakdowns, context } = run({ branch: { agentId: "centro", label: "Centro" } });
    expect(metrics.current.sales).toBe(1100);
    expect(metrics.reference.sales).toBe(500);
    expect(breakdowns.byBranch).toEqual([]);
    expect(context.branch).toBe("Centro");
  });

  it("avisa cuando el tramo del mes anterior tiene días sin ventas (posible hueco de captura)", () => {
    const { quality } = run();
    // Solo 2 de 10 días del tramo de octubre tienen ventas.
    expect(quality.warnings.some((w) => w.includes("2 de 10 días del tramo del mes anterior"))).toBe(true);
  });

  it("sin ventas en el tramo anterior no inventa una variación", () => {
    const only = rows.filter((r) => r.day.startsWith("2026-11"));
    const result = run({ rows: only });
    expect(result.metrics.status).toBe("no_comparison");
    expect(result.metrics.variation.salesPct).toBeNull();
    expect(result.metrics.accounting).toBeNull();
    expect(result.quality.status).toBe("partial");
    expect(result.summary).toContain("no hay base comparable");
  });

  it("sin ventas en ninguno de los dos tramos devuelve no_data", () => {
    const result = run({ rows: [] });
    expect(result.metrics.status).toBe("no_data");
    expect(result.quality.status).toBe("no_data");
  });

  it("recorta la referencia si el mes anterior es más corto que el día de hoy", () => {
    const now = new Date("2026-03-31T20:40:00Z"); // 31 de marzo; febrero tiene 28 días
    const febRows = [row("2026-03-31", 20, "centro", 100, 10), row("2026-02-28", 20, "centro", 50, 5), row("2026-02-28", 40, "centro", 50, 5)];
    const result = buildMonthToDate({ rows: febRows, now, timeZone: TZ, currency: null, branchLabels: labels });
    expect(result.metrics.window).toMatchObject({ referenceFrom: "2026-02-01", referenceTo: "2026-02-28", referenceClamped: true });
    // El último día de la referencia va completo (sin corte): 50 + 50.
    expect(result.metrics.reference.sales).toBe(100);
    expect(result.quality.warnings.some((w) => w.includes("se recortó"))).toBe(true);
  });

  it("el día 1 antes de la primera franja cerrada no hay ventana para comparar", () => {
    const now = new Date("2026-11-01T05:10:00Z"); // 00:10 en Bogotá
    const result = run({ now });
    expect(result.metrics.status).toBe("no_data");
    expect(result.context.cutoffLocal).toBeNull();
    expect(result.summary).toContain("día 1");
  });

  it("cruza el cambio de año: enero contra diciembre", () => {
    const now = new Date("2027-01-05T20:40:00Z");
    const result = buildMonthToDate({
      rows: [row("2027-01-02", 20, "centro", 200, 20), row("2026-12-02", 20, "centro", 100, 10)],
      now,
      timeZone: TZ,
      currency: null,
      branchLabels: labels,
    });
    expect(result.metrics.window).toMatchObject({ currentFrom: "2027-01-01", referenceFrom: "2026-12-01", referenceTo: "2026-12-05" });
    expect(result.metrics.variation.salesPct).toBe(100);
  });
});
