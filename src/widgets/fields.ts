/**
 * Lista blanca de campos que un widget puede elegir. Es la barrera contra
 * inyección SQL: el usuario arma su consulta eligiendo nombres de campo
 * libremente, así que el backend NUNCA puede meter esos strings directo en
 * el SQL de Athena — solo se acepta lo que está acá, y se traduce a la
 * columna real (ver `numericColumn`/`categoricalColumn`) en vez de usar el
 * string del usuario tal cual.
 */

export const NUMERIC_FIELDS = ["quantity", "unitPrice", "subtotal", "discount", "tip", "total"] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

/**
 * `discount`/`tip`/`total` son del TICKET, no del ítem — se escriben
 * repetidos en cada fila de `writeAnalyticsRows.ts` (una fila por ítem, no
 * por ticket). Sumarlos/promediarlos directo cuenta esa repetición: un
 * ticket de 3 ítems infla su total 3 veces. `queryBuilder.ts` los agrega a
 * través de una sub-consulta que colapsa por ticket primero — ver ahí.
 * `quantity`/`unitPrice`/`subtotal` sí son genuinamente por ítem, no
 * tienen este problema.
 */
export const TICKET_LEVEL_FIELDS: NumericField[] = ["discount", "tip", "total"];

export function isTicketLevelField(field: string): boolean {
  return (TICKET_LEVEL_FIELDS as readonly string[]).includes(field);
}

/** Pseudo-campo: cuenta tickets (eventos), no filas de ítem — ver queryBuilder.ts. */
export const EVENT_COUNT_FIELD = "event_count";

export const CATEGORICAL_FIELDS = ["port", "status", "parsedBy", "description"] as const;
export type CategoricalField = (typeof CATEGORICAL_FIELDS)[number];

export const AGGREGATIONS = ["sum", "avg", "max", "min", "count"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

// Nombre de campo "de negocio" (camelCase, el que ve el usuario) → columna
// real en la tabla de Athena (todo en minúsculas — ver el esquema en
// ticket-parsing-cloud-stack.ts).
const NUMERIC_COLUMN_BY_FIELD: Record<NumericField, string> = {
  quantity: "quantity",
  unitPrice: "unitprice",
  subtotal: "subtotal",
  discount: "discount",
  tip: "tip",
  total: "total",
};

const CATEGORICAL_COLUMN_BY_FIELD: Record<CategoricalField, string> = {
  port: "port",
  status: "status",
  parsedBy: "parsedby",
  description: "description",
};

export function isValidMetricField(field: string): field is NumericField | typeof EVENT_COUNT_FIELD {
  return field === EVENT_COUNT_FIELD || (NUMERIC_FIELDS as readonly string[]).includes(field);
}

export function isValidGroupByField(field: string): field is CategoricalField {
  return (CATEGORICAL_FIELDS as readonly string[]).includes(field);
}

export function isValidAggregation(aggregation: string): aggregation is Aggregation {
  return (AGGREGATIONS as readonly string[]).includes(aggregation);
}

export function numericColumn(field: NumericField): string {
  return NUMERIC_COLUMN_BY_FIELD[field];
}

export function categoricalColumn(field: CategoricalField): string {
  return CATEGORICAL_COLUMN_BY_FIELD[field];
}
