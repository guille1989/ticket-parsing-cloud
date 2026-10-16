import { buildWidgetQuery } from "../../src/widgets/queryBuilder";
import type { WidgetRecord } from "../../src/shared/types";

// Sin `dateFrom`/`dateTo` explícitos, el año por default sale de "ahora"
// (ver DEFAULT_YEAR_LOOKBACK en queryBuilder.ts) — se calcula acá igual
// que en el código para no hardcodear un año que se rompería con el
// tiempo.
const CURRENT_YEAR = new Date().getUTCFullYear();
const DEFAULT_FROM_YEAR = String(CURRENT_YEAR - 1);
const DEFAULT_TO_YEAR = String(CURRENT_YEAR);

function widget(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    tenantId: "t1",
    widgetId: "w1",
    name: "Ventas por producto",
    visualization: "bar",
    metric: { field: "subtotal", aggregation: "sum" },
    groupBy: "description",
    createdAt: "2026-07-29T20:00:00.000Z",
    ...overrides,
  };
}

test("KPI sin groupBy, campo por ítem: una sola fila, agregación directa sin sub-consulta", () => {
  const { sql, params } = buildWidgetQuery(
    widget({ visualization: "kpi", groupBy: undefined, metric: { field: "subtotal", aggregation: "sum" } }),
  );

  expect(sql).toBe("SELECT SUM(subtotal) AS value FROM ticket_analytics.ticket_items WHERE tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR)");
  expect(params).toEqual(["t1", DEFAULT_FROM_YEAR, DEFAULT_TO_YEAR]);
});

// total/discount/tip vienen repetidos una vez por ítem del ticket al que
// pertenecen (ver fields.ts) — sumarlos/promediarlos directo los cuenta de
// más. Se ve exactamente en este caso: un ticket real de $3600 con 3 ítems
// devolvía $10800 antes de este fix (probado contra Athena real).
test("KPI sin groupBy, campo de TICKET (total/discount/tip): colapsa por ticketid antes de sumar", () => {
  const { sql, params } = buildWidgetQuery(
    widget({ visualization: "kpi", groupBy: undefined, metric: { field: "total", aggregation: "sum" } }),
  );

  expect(sql).toBe(
    "SELECT SUM(total) AS value FROM (SELECT ticketid, MAX(total) AS total FROM ticket_analytics.ticket_items " +
      "WHERE tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) GROUP BY ticketid)",
  );
  expect(params).toEqual(["t1", DEFAULT_FROM_YEAR, DEFAULT_TO_YEAR]);
});

test("bar/donut con groupBy y campo de TICKET: colapsa por (ticketid, groupBy) antes de agrupar afuera", () => {
  const { sql } = buildWidgetQuery(
    widget({ metric: { field: "total", aggregation: "sum" }, groupBy: "port" }),
  );

  expect(sql).toBe(
    "SELECT port AS label, SUM(total) AS value FROM (SELECT ticketid, port, MAX(total) AS total " +
      "FROM ticket_analytics.ticket_items WHERE tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) GROUP BY ticketid, port) " +
      "GROUP BY port ORDER BY value DESC LIMIT 200",
  );
});

test("rechaza agrupar un campo de ticket (total/discount/tip) por description — no hay forma correcta de repartirlo por ítem", () => {
  expect(() => buildWidgetQuery(widget({ metric: { field: "total", aggregation: "sum" }, groupBy: "description" }))).toThrow(
    /no se puede agrupar/,
  );
  expect(() => buildWidgetQuery(widget({ metric: { field: "discount", aggregation: "sum" }, groupBy: "description" }))).toThrow(
    /no se puede agrupar/,
  );
  expect(() => buildWidgetQuery(widget({ metric: { field: "tip", aggregation: "sum" }, groupBy: "description" }))).toThrow(
    /no se puede agrupar/,
  );
});

test("agrupar un campo de ticket por un campo NO-description (port/status/parsedBy) sí es válido", () => {
  expect(() => buildWidgetQuery(widget({ metric: { field: "total", aggregation: "sum" }, groupBy: "status" }))).not.toThrow();
});

test("bar/donut con groupBy: agrupa, ordena por value y limita a 200", () => {
  const { sql } = buildWidgetQuery(widget());

  expect(sql).toContain("SELECT description AS label, SUM(subtotal) AS value");
  expect(sql).toContain("GROUP BY description");
  expect(sql).toContain("ORDER BY value DESC");
  expect(sql).toContain("LIMIT 200");
});

test("maxGroups recorta las categorías (lo usa el asistente) sin tocar el tope temporal", () => {
  expect(buildWidgetQuery(widget(), 50).sql).toMatch(/LIMIT 50$/);
  expect(buildWidgetQuery(widget({ metric: { field: "total", aggregation: "sum" }, groupBy: "port" }), 50).sql).toMatch(/LIMIT 50$/);
  expect(buildWidgetQuery(widget({ metric: { field: "total", aggregation: "sum" }, groupBy: "day" }), 50).sql).toMatch(/LIMIT 800$/);
});

test("line temporal agrupa por día y ordena cronológicamente", () => {
  const { sql } = buildWidgetQuery(
    widget({ visualization: "line", metric: { field: "total", aggregation: "sum" }, groupBy: "day" }),
  );

  expect(sql).toContain("substr(capturedat, 1, 10) AS group_label");
  expect(sql).toContain("SELECT group_label AS label, SUM(total) AS value");
  expect(sql).toContain("GROUP BY group_label ORDER BY label ASC");
  expect(sql).toContain("ORDER BY label ASC");
  expect(sql.match(/capturedat/g)).toHaveLength(2);
});

test("event_count siempre es COUNT(DISTINCT ticketid), sin importar la agregación elegida", () => {
  const { sql } = buildWidgetQuery(widget({ metric: { field: "event_count", aggregation: "avg" } }));
  expect(sql).toContain("COUNT(DISTINCT ticketid) AS value");
  expect(sql).not.toContain("AVG");
});

test("cada filtro presente agrega su condición y su parámetro, en orden — el año sale de dateFrom/dateTo", () => {
  const { sql, params } = buildWidgetQuery(
    widget({
      filters: { dateFrom: "2026-07-01", dateTo: "2026-07-31", port: "COM3", status: "parsed" },
    }),
  );

  expect(sql).toContain("tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) AND capturedat >= ? AND capturedat <= ? AND port = ? AND status = ?");
  // dateTo de solo fecha se lleva al final del día — si no, los tickets del 31 quedaban afuera.
  expect(params).toEqual(["t1", "2026", "2026", "2026-07-01", "2026-07-31T23:59:59.999Z", "COM3", "parsed"]);
});

test("dateTo con hora se respeta tal cual", () => {
  const { params } = buildWidgetQuery(widget({ filters: { dateTo: "2026-07-31T12:00:00.000Z" } }));
  expect(params).toContain("2026-07-31T12:00:00.000Z");
});

test("descriptionContains filtra por nombre de producto sin distinguir mayúsculas, como parámetro", () => {
  const { sql, params } = buildWidgetQuery(
    widget({ metric: { field: "subtotal", aggregation: "sum" }, filters: { descriptionContains: "Horne" } }),
  );
  expect(sql).toContain("strpos(lower(description), lower(?)) > 0");
  expect(sql).not.toContain("Horne");
  expect(params.at(-1)).toBe("Horne");
});

test("descriptionContains con un campo del ticket (total) se rechaza: sumaría tickets enteros, no el producto", () => {
  expect(() =>
    buildWidgetQuery(widget({ metric: { field: "total", aggregation: "sum" }, filters: { descriptionContains: "empa" } })),
  ).toThrow(/usá "subtotal"/);
});

// Acota la proyección de particiones de Athena a un rango chico (ver el
// comentario sobre DEFAULT_YEAR_LOOKBACK) — sin esto, un tenant nuevo con
// un solo ticket de hoy obligaba a Athena a barrer ~4500 particiones
// proyectadas (2024-2035 × 12 × 31) y tardaba más de 20s.
test("sin filtros explícitos, igual acota por año (para no barrer toda la proyección de Athena)", () => {
  const { sql, params } = buildWidgetQuery(widget({ filters: undefined }));
  expect(sql).toContain("WHERE tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR)");
  expect(sql).not.toMatch(/capturedat|port =|status =/);
  expect(params).toEqual(["t1", DEFAULT_FROM_YEAR, DEFAULT_TO_YEAR]);
});

test("los VALORES de los filtros nunca se interpolan directo en el SQL — siempre van como parámetro", () => {
  const malicious = "COM3'; DROP TABLE ticket_items; --";
  const { sql, params } = buildWidgetQuery(widget({ filters: { port: malicious } }));

  expect(sql).not.toContain(malicious);
  expect(sql).toContain("port = ?");
  expect(params).toContain(malicious);
});

test("un metric.field fuera de la lista blanca nunca llega a generar SQL", () => {
  expect(() =>
    buildWidgetQuery(widget({ metric: { field: "'; DROP TABLE ticket_items; --", aggregation: "sum" } as never })),
  ).toThrow(/campo de métrica inválido/);
});

test("una aggregation fuera de la lista blanca nunca llega a generar SQL", () => {
  expect(() => buildWidgetQuery(widget({ metric: { field: "subtotal", aggregation: "median" as never } }))).toThrow(
    /agregación inválida/,
  );
});

test("un groupBy fuera de la lista blanca nunca llega a generar SQL", () => {
  expect(() => buildWidgetQuery(widget({ groupBy: "1=1; --" }))).toThrow(/campo de agrupación inválido/);
});

test("los distintos campos de agregación producen la función SQL correcta", () => {
  expect(buildWidgetQuery(widget({ visualization: "kpi", groupBy: undefined, metric: { field: "total", aggregation: "avg" } })).sql).toContain(
    "AVG(total)",
  );
  expect(buildWidgetQuery(widget({ visualization: "kpi", groupBy: undefined, metric: { field: "total", aggregation: "max" } })).sql).toContain(
    "MAX(total)",
  );
  expect(buildWidgetQuery(widget({ visualization: "kpi", groupBy: undefined, metric: { field: "total", aggregation: "min" } })).sql).toContain(
    "MIN(total)",
  );
});
