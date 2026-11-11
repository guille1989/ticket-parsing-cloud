import { buildProductStars, normalizeProductName } from "../../../src/analytics/engine/productStars";
import { buildProductQuery, buildProductWindowQuery, parseProductRows, productWindow } from "../../../src/analytics/engine/productData";
import type { ProductRow } from "../../../src/analytics/engine/types";
import { NOW, TZ } from "./fixtures";

const cur = (description: string, revenue: number, units: number): ProductRow => ({ description, period: "current", revenue, units });
const prev = (description: string, revenue: number, units: number): ProductRow => ({ description, period: "previous", revenue, units });

function stars(rows: ProductRow[], extra: Partial<Parameters<typeof buildProductStars>[0]> = {}) {
  return buildProductStars({ rows, now: NOW, timeZone: TZ, currency: null, days: 30, ...extra });
}

describe("normalizeProductName", () => {
  it("ignora mayúsculas, tildes, signos y espacios repetidos", () => {
    expect(normalizeProductName("  CAFÉ  con leche. ")).toBe("cafe con leche");
    expect(normalizeProductName("Cafe-con Leche")).toBe("cafe con leche");
  });
});

describe("buildProductStars", () => {
  it("café 740 × 2,50 = 1.850: lidera ingresos y unidades, y el margen queda no disponible", () => {
    const result = stars([cur("CAFE CON LECHE", 1850, 740), cur("PAN DE MASA MADRE", 900, 150), prev("CAFE CON LECHE", 1500, 600), prev("PAN DE MASA MADRE", 800, 140)]);
    const [first, second] = result.breakdowns.byRevenue;
    expect(first).toMatchObject({ name: "CAFE CON LECHE", revenue: 1850, units: 740 });
    expect(second.name).toBe("PAN DE MASA MADRE");
    expect(first.revenueSharePct).toBeCloseTo(67.3, 1);
    expect(first.labels).toEqual(expect.arrayContaining(["billing_leader", "popularity"]));
    expect(result.metrics.margin).toEqual({ available: false, reason: "no se dispone de costes suficientes" });
    expect(result.quality.costCoveragePct).toBeNull();
    expect(result.summary).toContain("no puedo decir cuál es el más rentable");
    expect(result.summary).not.toMatch(/margen de \d/);
  });

  it("une solo nombres idénticos tras normalizar: 'CAFÉ LECHE' y 'cafe leche' suman; 'CAFE C/L' queda aparte", () => {
    const result = stars([cur("CAFÉ LECHE", 100, 10), cur("cafe leche", 50, 5), cur("CAFE C/L", 30, 3)]);
    expect(result.breakdowns.byRevenue).toHaveLength(2);
    expect(result.breakdowns.byRevenue[0]).toMatchObject({ name: "CAFÉ LECHE", revenue: 150, units: 15 });
    expect(result.quality.warnings.join(" ")).toContain("variantes de nombre");
  });

  it("producto nuevo sin base: crecimiento null y va a newProducts, no a byGrowth", () => {
    const result = stars([cur("TARTA", 400, 50), cur("CAFE", 1000, 100), prev("CAFE", 900, 90)]);
    const tarta = result.breakdowns.byRevenue.find((s) => s.name === "TARTA");
    expect(tarta?.unitsGrowthPct).toBeNull();
    expect(result.breakdowns.newProducts.map((s) => s.name)).toEqual(["TARTA"]);
    expect(result.breakdowns.byGrowth.map((s) => s.name)).not.toContain("TARTA");
  });

  it("crecimiento de +50 % en unidades etiqueta al emergente; con muy poco volumen no cuenta", () => {
    const result = stars([cur("TARTA", 600, 30), prev("TARTA", 400, 20), cur("RARO", 30, 3), prev("RARO", 10, 1), cur("CAFE", 2000, 100), prev("CAFE", 1990, 99)]);
    const tarta = result.breakdowns.byRevenue.find((s) => s.name === "TARTA");
    expect(tarta?.unitsGrowthPct).toBe(50);
    expect(tarta?.labels).toContain("emerging");
    expect(result.breakdowns.byRevenue.find((s) => s.name === "RARO")?.unitsGrowthPct).toBeNull();
    expect(result.breakdowns.byGrowth[0].name).toBe("TARTA");
  });

  it("concentración Top 5 sobre los ingresos totales del negocio, no solo del Top 10", () => {
    const rows = ["A", "B", "C", "D", "E", "F", "G"].map((name, i) => cur(name, 100 - i * 10, 10));
    const result = stars(rows);
    // Top 5 = 100+90+80+70+60 = 400 de un total de 100+90+80+70+60+50+40 = 490.
    expect(result.metrics.totalRevenue).toBe(490);
    expect(result.metrics.top5ConcentrationPct).toBeCloseTo(81.6, 1);
  });

  it("sin periodo anterior: ranking sí, crecimiento no, calidad parcial", () => {
    const result = stars([cur("CAFE", 1000, 100)]);
    expect(result.breakdowns.byGrowth).toEqual([]);
    expect(result.quality.status).toBe("partial");
    expect(result.quality.warnings.join(" ")).toContain("no se calcula crecimiento");
  });

  it("sin ventas con detalle de producto: no hay ranking y lo dice", () => {
    const result = stars([]);
    expect(result.quality.status).toBe("no_data");
    expect(result.summary).toContain("no puedo armar el ranking");
    expect(result.metrics.top5ConcentrationPct).toBeNull();
  });

  it("devoluciones (cantidad negativa) restan: pueden cambiar el ranking", () => {
    const result = stars([cur("A", 500, 50), cur("A", -450, -45), cur("B", 300, 30)]);
    expect(result.breakdowns.byRevenue.map((s) => s.name)).toEqual(["B", "A"]);
  });
});

describe("consulta de productos", () => {
  it("compara 30 días completos (sin hoy) contra los 30 anteriores", () => {
    expect(productWindow(NOW, TZ, 30)).toEqual({ currentFrom: "2026-10-11", currentTo: "2026-11-09", previousFrom: "2026-09-11", previousTo: "2026-10-10" });
  });

  it("los parámetros siguen el orden de los ? y el tenant nunca va en el SQL", () => {
    const { sql, params } = buildProductQuery("tenant-x", TZ, NOW, 30);
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params).toEqual(["2026-10-11", "tenant-x", "2026", "2026", "2026-09-11", "2026-11-09", "2026-10-11", "2026-10-10"]);
    expect(sql).not.toContain("tenant-x");
    expect(sql).toContain("COALESCE(voided, false) = false");
  });

  it("con dos ventanas separadas excluye los días del hueco entre ellas", () => {
    const window = { currentFrom: "2026-11-09", currentTo: "2026-11-09", previousFrom: "2026-11-02", previousTo: "2026-11-02" };
    const { sql, params } = buildProductWindowQuery("t1", TZ, NOW, window);
    expect(sql).toContain(">= ? OR");
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params.slice(-2)).toEqual(["2026-11-09", "2026-11-02"]);
  });

  it("filtra por sucursal con parámetro y rechaza una zona que no sea un nombre real", () => {
    const query = buildProductQuery("t1", TZ, NOW, 30, "agent-1");
    expect(query.sql).toContain("agentid = ?");
    expect(query.params[query.params.length - 1]).toBe("agent-1");
    expect(() => buildProductQuery("t1", "America/Bogota'; DROP TABLE x --", NOW, 30)).toThrow("zona horaria inválida");
  });

  it("parsea filas de Athena y falla si el periodo o la cifra son inválidos", () => {
    expect(parseProductRows([{ description: "CAFE", period: "current", revenue: "1850", units: "740" }])).toEqual([cur("CAFE", 1850, 740)]);
    expect(() => parseProductRows([{ description: "x", period: "otro", revenue: "1", units: "1" }])).toThrow("fila inválida");
    expect(() => parseProductRows([{ description: "x", period: "current", revenue: "abc", units: "1" }])).toThrow("fila inválida");
  });
});
