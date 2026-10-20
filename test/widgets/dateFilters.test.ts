import { dateFilterError, isValidDateFilter, normalizeDateFilter } from "../../src/widgets/dateFilters";
import { buildWidgetQuery } from "../../src/widgets/queryBuilder";
import type { WidgetRecord } from "../../src/shared/types";

test.each(["2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-20T24:00:00Z", "2026-10-20T12:60:00Z", "2026-10-20T12:00:60Z", "2026-10-20T12:00:00+24:00"])("rechaza fechas de calendario u horas inválidas: %s", (value) => {
  expect(isValidDateFilter(value)).toBe(false);
  expect(dateFilterError({ dateFrom: value })).toMatch(/dateFrom inválida/);
});

test("acepta año bisiesto, normaliza instantes y valida rangos de instantes según UTC", () => {
  expect(isValidDateFilter("2024-02-29")).toBe(true);
  expect(normalizeDateFilter("2026-10-20T12:00:00")).toBe("2026-10-20T12:00:00.000Z");
  expect(normalizeDateFilter("2026-01-01T00:00:00+02:00")).toBe("2025-12-31T22:00:00.000Z");
  expect(dateFilterError({ dateFrom: "2026-01-01T00:00:00Z", dateTo: "2026-01-01T00:00:00+02:00" })).toMatch(/posterior/);
  expect(dateFilterError({ dateFrom: "2026-10-20T12:00:00Z", dateTo: "2026-10-20T13:00:00Z" })).toBeUndefined();
  expect(dateFilterError({ dateFrom: "2026-10-20T12:00:00Z" }, true)).toMatch(/YYYY-MM-DD/);
});

test.each([
  { dateFrom: "2026-10-20", dateTo: "2026-10-19T23:00:00Z" },
  { dateFrom: "2026-10-20T22:30:00Z", dateTo: "2026-10-20" },
])("no mezcla días locales con instantes UTC: %j", (range) => {
  expect(dateFilterError(range)).toMatch(/mismo formato: ambas fechas YYYY-MM-DD o ambos instantes ISO-8601/);
});

const widget: WidgetRecord = {
  tenantId: "t1", widgetId: "w1", name: "Ventas", visualization: "kpi", metric: { field: "total", aggregation: "sum" }, createdAt: "2026-01-01T00:00:00.000Z",
};

test.each(["America/Bogota", "Pacific/Kiritimati"])("el primer y último día local permiten particiones UTC adyacentes: %s", (tz) => {
  expect(buildWidgetQuery({ ...widget, filters: { dateFrom: "2026-01-01", dateTo: "2026-01-01" } }, undefined, tz).params.slice(1, 3)).toEqual(["2025", "2026"]);
  expect(buildWidgetQuery({ ...widget, filters: { dateFrom: "2026-12-31", dateTo: "2026-12-31" } }, undefined, tz).params.slice(1, 3)).toEqual(["2026", "2027"]);
});

test("UTC conserva las particiones exactas y timestamp con offset usa su año UTC", () => {
  expect(buildWidgetQuery({ ...widget, filters: { dateFrom: "2026-01-01", dateTo: "2026-01-01" } }, undefined, "UTC").params.slice(1, 3)).toEqual(["2026", "2026"]);
  const query = buildWidgetQuery({ ...widget, filters: { dateFrom: "2026-01-01T00:00:00+02:00", dateTo: "2026-01-01T01:00:00+02:00" } });
  expect(query.params.slice(1, 3)).toEqual(["2025", "2025"]);
  expect(query.params.slice(3)).toEqual(["2025-12-31T22:00:00.000Z", "2025-12-31T23:00:00.000Z"]);
});

test("la última barrera rechaza fechas inválidas e intervalos invertidos guardados o producidos por el agente", () => {
  expect(() => buildWidgetQuery({ ...widget, filters: { dateTo: "2026-02-31" } })).toThrow(/dateTo inválida/);
  expect(() => buildWidgetQuery({ ...widget, filters: { dateFrom: "2026-10-20", dateTo: "2026-10-19" } })).toThrow(/posterior/);
});
