import {
  CATEGORICAL_FIELDS,
  EVENT_COUNT_FIELD,
  NUMERIC_FIELDS,
  categoricalColumn,
  isValidAggregation,
  isValidGroupByField,
  isValidMetricField,
  VOLUME_PATTERN,
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

test.each([
  ["AGUA TRATADA 350 ML SIN GAS", "350", "ml"],
  ["AGUA TRATADA 600 ML BALA CON GAS", "600", "ml"],
  ["AGUA TRATADA 350ML", "350", "ml"],
  ["BOTELLON 20 LT", "20", "lt"],
  ["BOTELLON 20 LTS.", "20", "lts"],
  ["AGUA 1,5 LITROS", "1,5", "litros"],
  ["ARROZ 500 GR", "500", "gr"],
])("VOLUME_PATTERN (versión JS de la regex de Athena): %s", (description, number, unit) => {
  const match = new RegExp(VOLUME_PATTERN).exec(description.toLowerCase());
  expect(match?.[1]).toBe(number);
  expect(match?.[3]).toBe(unit);
});

test.each(["CASINO Y RESTAURANTE SERV DE COMEDOR", "AGUA LIGHT", "2 GASEOSAS"])("VOLUME_PATTERN no coincide: %s", (description) => {
  expect(new RegExp(VOLUME_PATTERN).test(description.toLowerCase())).toBe(false);
});

test("volume es un groupBy válido y su columna es una expresión sin placeholders", () => {
  expect(isValidGroupByField("volume")).toBe(true);
  expect(categoricalColumn("volume")).not.toContain("?");
});
