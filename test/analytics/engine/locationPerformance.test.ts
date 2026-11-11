import { buildLocationPerformance } from "../../../src/analytics/engine/locationPerformance";
import { buildSalesSlotsQuery, parseSalesSlotRows } from "../../../src/analytics/engine/salesData";
import { UNASSIGNED_AGENT } from "../../../src/analytics/engine/types";
import { LAST_TUESDAY, NOW, TODAY, TZ, row, tuesday } from "./fixtures";

const labels = new Map([
  ["centro", "Centro"],
  ["norte", "Norte"],
]);

const twoBranches = [
  ...tuesday(LAST_TUESDAY, "centro", { sales: 690, tickets: 100 }),
  ...tuesday(LAST_TUESDAY, "norte", { sales: 410, tickets: 75 }),
  ...tuesday(TODAY, "centro", { sales: 780, tickets: 110 }),
  ...tuesday(TODAY, "norte", { sales: 468, tickets: 76 }),
];

const run = (rows: typeof twoBranches, period: "today" | "last_7_days" = "today") =>
  buildLocationPerformance({ rows, now: NOW, timeZone: TZ, currency: null, period, branchLabels: labels });

describe("buildLocationPerformance (hoy)", () => {
  it("Centro lidera volumen y Norte crece más: un ganador por dimensión, no un único mejor", () => {
    const result = run(twoBranches);
    const [centro, norte] = result.breakdowns.byLocation;
    expect(centro).toMatchObject({ branch: "Centro", sales: 780, tickets: 110 });
    expect(norte).toMatchObject({ branch: "Norte", sales: 468 });
    expect(centro.growthPct).toBeCloseTo(13.04, 2);
    expect(norte.growthPct).toBeCloseTo(14.15, 2);
    expect(result.metrics.winners).toEqual({ sales: "Centro", growth: "Norte", avgTicket: "Centro" });
    expect(result.metrics.totalSales).toBe(1248);
    expect(centro.sharePct).toBeCloseTo(62.5, 1);
    expect(result.metrics.profitability.available).toBe(false);
    expect(result.summary).toContain("No elijo un único mejor local");
    expect(result.summary).toContain("sin costes");
  });

  it("una sola sucursal: devuelve sus indicadores y explica que no hay comparación", () => {
    const result = run(twoBranches.filter((r) => r.agentId === "centro"));
    expect(result.metrics.singleLocation).toBe(true);
    expect(result.summary).toContain("una sola sucursal");
    expect(result.quality.warnings.join(" ")).toContain("no hay comparación entre sucursales");
  });

  it("sucursal nueva sin histórico: aparece con variación null y se avisa, sin ser la que 'más crece'", () => {
    const rows = [...twoBranches, ...tuesday(TODAY, "nueva", { sales: 200, tickets: 20 })];
    const result = run(rows);
    const nueva = result.breakdowns.byLocation.find((s) => s.agentId === "nueva");
    expect(nueva).toMatchObject({ growthPct: null, growthNote: "sin histórico suficiente" });
    expect(result.metrics.winners.growth).toBe("Norte");
    expect(result.quality.status).toBe("partial");
    expect(result.quality.warnings.join(" ")).toContain("sin histórico suficiente");
  });

  it("sucursal que vendía la semana pasada y hoy no registra nada: aviso de captura, no hallazgo de ventas", () => {
    const result = run(twoBranches.filter((r) => !(r.agentId === "norte" && r.day === TODAY)));
    expect(result.insights.some((i) => i.id === "silent_norte" && i.headline.includes("captura"))).toBe(true);
    expect(result.metrics.winners.growth).not.toBe("Norte");
  });

  it("las ventas sin agente se nombran 'Sin sucursal asignada'", () => {
    const result = run([...twoBranches, row(TODAY, 20, UNASSIGNED_AGENT, 10, 1)]);
    expect(result.breakdowns.byLocation.some((s) => s.branch === "Sin sucursal asignada")).toBe(true);
  });

  it("ticket medio solo se compara con suficientes tickets", () => {
    const rows = [...twoBranches, ...tuesday(TODAY, "mini", { sales: 5000, tickets: 2 })];
    expect(run(rows).metrics.winners.avgTicket).not.toBe("mini");
  });

  it("sin ventas en ninguna sucursal no inventa ganadores", () => {
    const result = run([]);
    expect(result.metrics.winners).toEqual({ sales: null, growth: null, avgTicket: null });
    expect(result.quality.status).toBe("no_data");
  });
});

describe("buildLocationPerformance (últimos 7 días)", () => {
  it("compara 7 días cerrados con los 7 anteriores y no cuenta hoy", () => {
    const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => row(day(-7 + i), 20, "centro", 100, 10)), // 700 los 7 días cerrados
      ...Array.from({ length: 7 }, (_, i) => row(day(-14 + i), 20, "centro", 50, 5)), // 350 los 7 anteriores
      row(TODAY, 20, "centro", 9999, 99), // hoy es parcial: no entra
    ];
    const result = run(rows, "last_7_days");
    const [centro] = result.breakdowns.byLocation;
    expect(centro).toMatchObject({ sales: 700, referenceSales: 350, growthPct: 100 });
    expect(result.context.cutoffLocal).toBeNull();
  });
});

describe("consulta de ventas por franja", () => {
  it("pide ~2 meses, agrupa por media hora local y manda el tenant como parámetro", () => {
    const { sql, params } = buildSalesSlotsQuery("tenant-x", TZ, NOW);
    expect(params).toEqual(["tenant-x", "2026", "2026", "2026-09-08"]);
    expect(sql).not.toContain("tenant-x");
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(sql).toContain("at_timezone(from_iso8601_timestamp(capturedat), 'America/Bogota')");
    expect(sql).toContain("minute(");
    expect(sql).toContain("MAX(total) AS total");
    expect(sql).toContain("COALESCE(doctype, 'sale') = 'sale'");
    expect(sql).toContain("status IN ('parsed', 'needs_review')");
  });

  it("rechaza una zona que no sea un nombre real (se inlinea en el SQL)", () => {
    expect(() => buildSalesSlotsQuery("t1", "UTC'; DROP TABLE x --", NOW)).toThrow("zona horaria inválida");
  });

  it("parsea las franjas y manda las ventas sin agente a su propio bucket", () => {
    expect(
      parseSalesSlotRows([
        { slot_label: "2026-11-03 15:30", agentid: "a1", sales: "125000.5", tickets: "7" },
        { slot_label: "2026-11-03 00:00", agentid: null, sales: "1", tickets: "1" },
      ]),
    ).toEqual([
      { day: "2026-11-03", slot: 31, agentId: "a1", sales: 125000.5, tickets: 7 },
      { day: "2026-11-03", slot: 0, agentId: UNASSIGNED_AGENT, sales: 1, tickets: 1 },
    ]);
    expect(() => parseSalesSlotRows([{ slot_label: "2026-11-03 15:15", agentid: "a", sales: "1", tickets: "1" }])).toThrow("fila inválida");
  });
});
