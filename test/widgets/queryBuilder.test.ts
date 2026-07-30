import { buildWidgetQuery } from "../../src/widgets/queryBuilder";
import type { WidgetRecord } from "../../src/shared/types";

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

  expect(sql).toBe("SELECT SUM(subtotal) AS value FROM ticket_analytics.ticket_items WHERE tenant = ?");
  expect(params).toEqual(["t1"]);
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
    "SELECT SUM(total) AS value FROM (SELECT ticketid, MAX(total) AS total FROM ticket_analytics.ticket_items WHERE tenant = ? GROUP BY ticketid)",
  );
  expect(params).toEqual(["t1"]);
});

test("bar/donut con groupBy y campo de TICKET: colapsa por (ticketid, groupBy) antes de agrupar afuera", () => {
  const { sql } = buildWidgetQuery(
    widget({ metric: { field: "total", aggregation: "sum" }, groupBy: "port" }),
  );

  expect(sql).toBe(
    "SELECT port AS label, SUM(total) AS value FROM (SELECT ticketid, port, MAX(total) AS total " +
      "FROM ticket_analytics.ticket_items WHERE tenant = ? GROUP BY ticketid, port) " +
      "GROUP BY port ORDER BY value DESC LIMIT 50",
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

test("bar/donut con groupBy: agrupa, ordena por value y limita a 50", () => {
  const { sql } = buildWidgetQuery(widget());

  expect(sql).toContain("SELECT description AS label, SUM(subtotal) AS value");
  expect(sql).toContain("GROUP BY description");
  expect(sql).toContain("ORDER BY value DESC");
  expect(sql).toContain("LIMIT 50");
});

test("event_count siempre es COUNT(DISTINCT ticketid), sin importar la agregación elegida", () => {
  const { sql } = buildWidgetQuery(widget({ metric: { field: "event_count", aggregation: "avg" } }));
  expect(sql).toContain("COUNT(DISTINCT ticketid) AS value");
  expect(sql).not.toContain("AVG");
});

test("cada filtro presente agrega su condición y su parámetro, en orden", () => {
  const { sql, params } = buildWidgetQuery(
    widget({
      filters: { dateFrom: "2026-07-01", dateTo: "2026-07-31", port: "COM3", status: "parsed" },
    }),
  );

  expect(sql).toContain("tenant = ? AND capturedat >= ? AND capturedat <= ? AND port = ? AND status = ?");
  expect(params).toEqual(["t1", "2026-07-01", "2026-07-31", "COM3", "parsed"]);
});

test("sin filtros, solo el tenant va como condición", () => {
  const { sql, params } = buildWidgetQuery(widget({ filters: undefined }));
  expect(sql).toContain("WHERE tenant = ?");
  expect(sql).not.toMatch(/capturedat|port =|status =/);
  expect(params).toEqual(["t1"]);
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
