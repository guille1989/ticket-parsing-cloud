import { buildSalesHistoryQuery, parseSalesHistoryRows, UNASSIGNED_AGENT } from "../../src/travis/salesHistory";

describe("buildSalesHistoryQuery", () => {
  const now = new Date("2026-11-03T12:00:00Z");

  it("pide 8 semanas hacia atrás en fecha local y manda los valores como parámetros", () => {
    const query = buildSalesHistoryQuery("t1", "America/Bogota", now);
    expect(query.params).toEqual(["t1", "2026", "2026", "2026-09-08"]);
    expect(query.sql).not.toContain("t1");
    expect(query.sql.match(/\?/g)).toHaveLength(query.params.length);
  });

  it("agrupa por hora local y colapsa el total a un valor por ticket", () => {
    const { sql } = buildSalesHistoryQuery("t1", "America/Bogota", now);
    expect(sql).toContain("ticket_analytics.ticket_items");
    expect(sql).toContain("at_timezone(from_iso8601_timestamp(capturedat), 'America/Bogota')");
    expect(sql).toContain("MAX(total) AS total");
    expect(sql).toContain("GROUP BY ticketid, agentid");
    expect(sql).toContain("COALESCE(doctype, 'sale') = 'sale'");
    expect(sql).toContain("status IN ('parsed', 'needs_review')");
  });

  it("cruzando el año nuevo abarca las particiones de los dos años", () => {
    const query = buildSalesHistoryQuery("t1", "Europe/Madrid", new Date("2027-01-02T10:00:00Z"));
    expect(query.params.slice(1, 3)).toEqual(["2026", "2027"]);
  });

  it("rechaza una zona horaria que no sea un nombre real (se inlinea en el SQL)", () => {
    expect(() => buildSalesHistoryQuery("t1", "America/Bogota'; DROP TABLE x --", now)).toThrow("zona horaria inválida");
  });
});

describe("parseSalesHistoryRows", () => {
  it("convierte las filas de Athena y manda los tickets sin agente a un bucket propio", () => {
    const rows = parseSalesHistoryRows([
      { hour_label: "2026-11-03 14", agentid: "a1", sales: "125000.5", tickets: "7" },
      { hour_label: "2026-11-03 15", agentid: null, sales: "0", tickets: "1" },
    ]);
    expect(rows).toEqual([
      { day: "2026-11-03", hour: 14, agentId: "a1", sales: 125000.5, tickets: 7 },
      { day: "2026-11-03", hour: 15, agentId: UNASSIGNED_AGENT, sales: 0, tickets: 1 },
    ]);
  });

  it("falla ruidoso si la hora o el monto no son válidos", () => {
    expect(() => parseSalesHistoryRows([{ hour_label: "mañana", agentid: "a1", sales: "1", tickets: "1" }])).toThrow("fila inválida");
    expect(() => parseSalesHistoryRows([{ hour_label: "2026-11-03 14", agentid: "a1", sales: "abc", tickets: "1" }])).toThrow("fila inválida");
  });
});
