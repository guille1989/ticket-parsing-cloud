import {
  CATEGORICAL_FIELDS,
  EVENT_COUNT_FIELD,
  NUMERIC_FIELDS,
  categoricalColumn,
  isValidAggregation,
  isValidGroupByField,
  isValidMetricField,
  numericColumn,
} from "../../src/widgets/fields";

test("todos los campos numéricos declarados son válidos como métrica", () => {
  for (const field of NUMERIC_FIELDS) {
    expect(isValidMetricField(field)).toBe(true);
  }
});

test("event_count es un campo de métrica válido (pseudo-campo)", () => {
  expect(isValidMetricField(EVENT_COUNT_FIELD)).toBe(true);
});

test("un campo arbitrario no está en la lista blanca de métrica", () => {
  expect(isValidMetricField("password")).toBe(false);
  expect(isValidMetricField("'; DROP TABLE ticket_items; --")).toBe(false);
});

test("todos los campos categóricos declarados son válidos para agrupar", () => {
  for (const field of CATEGORICAL_FIELDS) {
    expect(isValidGroupByField(field)).toBe(true);
  }
});

test("un campo numérico no es válido como groupBy (son listas separadas)", () => {
  expect(isValidGroupByField("subtotal")).toBe(false);
});

test("un campo categórico no es válido como métrica", () => {
  expect(isValidMetricField("port")).toBe(false);
});

test("solo sum/avg/max/min/count son agregaciones válidas", () => {
  expect(isValidAggregation("sum")).toBe(true);
  expect(isValidAggregation("avg")).toBe(true);
  expect(isValidAggregation("max")).toBe(true);
  expect(isValidAggregation("min")).toBe(true);
  expect(isValidAggregation("count")).toBe(true);
  expect(isValidAggregation("median")).toBe(false);
});

test("numericColumn/categoricalColumn traducen a la columna real de Athena", () => {
  expect(numericColumn("unitPrice")).toBe("unitprice");
  expect(categoricalColumn("parsedBy")).toBe("parsedby");
});
