import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { example38ColParser } from "../../src/parsing/parsers/example38col";
import type { ParsedTicket } from "../../src/parsing/types";
import type { WidgetRecord } from "../../src/shared/types";
import { buildWidgetQuery } from "../../src/widgets/queryBuilder";

// Ejecuta el subconjunto SQL compartido por Athena/SQLite sobre filas reales.
// Así se comprueban resultados económicos y deduplicación, no solo el SQL.
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.function("strpos", (value, search) => String(value).indexOf(String(search)) + 1);
  db.exec("ATTACH DATABASE ':memory:' AS ticket_analytics");
  db.exec(`CREATE TABLE ticket_analytics.ticket_items (
    tenant TEXT, year TEXT, ticketid TEXT, capturedat TEXT, port TEXT,
    agentid TEXT, parsedby TEXT, status TEXT, description TEXT,
    quantity REAL, unitprice REAL, subtotal REAL, voided INTEGER,
    total REAL, discount REAL, tip REAL, tax REAL
  )`);
});
afterEach(() => db.close());

function addTicket(ticketid: string, parsed: ParsedTicket, status = "parsed", capturedat = "2026-07-01T12:00:00.000Z") {
  const insert = db.prepare("INSERT INTO ticket_analytics.ticket_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of parsed.items) {
    insert.run("t1", capturedat.slice(0, 4), ticketid, capturedat, "COM3", "a1", "deterministic", status,
      item.description, item.quantity, item.unitPrice, item.subtotal, item.voided ? 1 : 0,
      parsed.total, parsed.discount ?? null, parsed.tip ?? null, parsed.tax ?? null);
  }
}

function query(field: string, aggregation: "sum" | "avg" | "count" = "sum", extras: Partial<WidgetRecord> = {}) {
  const widget: WidgetRecord = {
    tenantId: "t1", widgetId: "w1", name: "Métrica", createdAt: "2026-07-01T00:00:00.000Z", visualization: "kpi",
    metric: { field, aggregation }, filters: { dateFrom: "2026-01-01", dateTo: "2026-12-31" }, ...extras,
  };
  const { sql, params } = buildWidgetQuery(widget);
  return db.prepare(sql).all(...params);
}

test("fixture con anulación: ventas 5250, tres unidades y ningún comprador de la hamburguesa anulada", () => {
  const parsed = example38ColParser.parse(readFileSync(join(process.cwd(), "fixtures/sample-tickets/05-item-anulado.txt"), "utf8"))!;
  addTicket("confirmado", parsed);
  addTicket("por-revisar", parsed, "needs_review");

  expect(query("subtotal")).toEqual([{ value: 5250 }]);
  expect(query("quantity")).toEqual([{ value: 3 }]);
  expect(query("total")).toEqual([{ value: 5250 }]);
  expect(query("event_count")).toEqual([{ value: 1 }]);
  expect(query("event_count", "count", { filters: { descriptionContains: "Hamburguesa" } })).toEqual([{ value: 0 }]);
  expect(query("event_count", "count", { groupBy: "description" }).map((row) => row.label)).not.toContain("Hamburguesa Compl.");
});

test("las consultas de revisión son explícitas y los diagnósticos conservan ambos estados", () => {
  const ticket: ParsedTicket = { total: 10, timestamp: "2026-07-01T12:00:00.000Z", items: [{ description: "Café", quantity: 1, unitPrice: 10, subtotal: 10 }] };
  addTicket("confirmado", ticket);
  addTicket("revisar", { ...ticket, total: 100 }, "needs_review");

  expect(query("total")).toEqual([{ value: 10 }]);
  expect(query("total", "sum", { filters: { status: "needs_review" } })).toEqual([{ value: 100 }]);
  expect(query("event_count", "count", { groupBy: "status" })).toHaveLength(2);
  expect(query("event_count", "count", { groupBy: "parsedBy" })).toEqual([{ label: "deterministic", value: 2 }]);
});

test("AVG temporal transporta los pesos por ticket: 100 y 10 en días de 1 y 99 tickets producen 10,9", () => {
  const ticket: ParsedTicket = { total: 100, timestamp: "2026-07-01T12:00:00.000Z", items: [
    { description: "A", quantity: 1, unitPrice: 50, subtotal: 50 },
    { description: "B", quantity: 1, unitPrice: 50, subtotal: 50 },
  ] };
  addTicket("caro", ticket);
  for (let n = 0; n < 99; n++) addTicket(`normal-${n}`, { ...ticket, total: 10 }, "parsed", "2026-07-02T12:00:00.000Z");
  const daily = query("total", "avg", { groupBy: "day" });
  expect(daily).toEqual([
    { label: "2026-07-01", value: 100, sample_count: 1 },
    { label: "2026-07-02", value: 10, sample_count: 99 },
  ]);
  const weighted = daily.reduce((sum, row) => sum + Number(row.value) * Number(row.sample_count), 0) /
    daily.reduce((sum, row) => sum + Number(row.sample_count), 0);
  expect(weighted).toBe(10.9);
  expect(query("total", "avg")).toEqual([{ value: 10.9, sample_count: 100 }]);
});

test("sin observaciones SUM/AVG siguen siendo NULL, mientras opcionales ausentes son cero por ticket observado", () => {
  expect(query("total")).toEqual([{ value: null }]);
  expect(query("discount", "avg")).toEqual([{ value: null, sample_count: 0 }]);
  const ticket: ParsedTicket = { total: 10, timestamp: "2026-07-01T12:00:00.000Z", items: [{ description: "Café", quantity: 1, unitPrice: 10, subtotal: 10 }] };
  addTicket("sin-descuento", ticket);
  addTicket("con-descuento", { ...ticket, discount: 2 });
  expect(query("discount", "avg")).toEqual([{ value: 1, sample_count: 2 }]);
  expect(query("tip")).toEqual([{ value: 0 }]);
  expect(query("tax")).toEqual([{ value: 0 }]);
});

test("fechas inclusivas y filtro histórico: un límite único antiguo no genera particiones invertidas", () => {
  const ticket: ParsedTicket = { total: 10, timestamp: "2024-01-01T00:00:00.000Z", items: [{ description: "Café", quantity: 1, unitPrice: 10, subtotal: 10 }] };
  addTicket("ultimo-segundo", ticket, "parsed", "2024-01-31T23:59:59.999Z");
  addTicket("dia-siguiente", ticket, "parsed", "2024-02-01T00:00:00.000Z");
  expect(query("total", "sum", { filters: { dateTo: "2024-01-31" } })).toEqual([{ value: 10 }]);
});
