/**
 * Lista blanca de campos que un widget puede elegir. Es la barrera contra
 * inyección SQL: el usuario arma su consulta eligiendo nombres de campo
 * libremente, así que el backend NUNCA puede meter esos strings directo en
 * el SQL de Athena — solo se acepta lo que está acá, y se traduce a la
 * columna real (ver `numericColumn`/`categoricalColumn`) en vez de usar el
 * string del usuario tal cual.
 */

export const NUMERIC_FIELDS = ["quantity", "unitPrice", "subtotal", "discount", "tip", "tax", "total"] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

/**
 * `discount`/`tip`/`tax`/`total` son del TICKET, no del ítem — se escriben
 * repetidos en cada fila de `writeAnalyticsRows.ts` (una fila por ítem, no
 * por ticket). Sumarlos/promediarlos directo cuenta esa repetición: un
 * ticket de 3 ítems infla su total 3 veces. `queryBuilder.ts` los agrega a
 * través de una sub-consulta que colapsa por ticket primero — ver ahí.
 * `quantity`/`unitPrice`/`subtotal` sí son genuinamente por ítem, no
 * tienen este problema.
 */
export const TICKET_LEVEL_FIELDS: NumericField[] = ["discount", "tip", "tax", "total"];

export function isTicketLevelField(field: string): boolean {
  return (TICKET_LEVEL_FIELDS as readonly string[]).includes(field);
}

/** Pseudo-campo: cuenta tickets (eventos), no filas de ítem — ver queryBuilder.ts. */
export const EVENT_COUNT_FIELD = "event_count";

export const CATEGORICAL_FIELDS = ["port", "agent", "status", "parsedBy", "description"] as const;
export type CategoricalField = (typeof CATEGORICAL_FIELDS)[number];
export const TEMPORAL_FIELDS = ["day", "hour"] as const;
export type TemporalField = (typeof TEMPORAL_FIELDS)[number];
export type GroupByField = CategoricalField | TemporalField;

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
  tax: "tax",
  total: "total",
};

const CATEGORICAL_COLUMN_BY_FIELD: Record<CategoricalField, string> = {
  port: "port",
  agent: "agentid",
  status: "status",
  parsedBy: "parsedby",
  description: "description",
};

export function isValidMetricField(field: string): field is NumericField | typeof EVENT_COUNT_FIELD {
  return field === EVENT_COUNT_FIELD || (NUMERIC_FIELDS as readonly string[]).includes(field);
}

export function isValidGroupByField(field: string): field is GroupByField {
  return (CATEGORICAL_FIELDS as readonly string[]).includes(field) || (TEMPORAL_FIELDS as readonly string[]).includes(field);
}

export function isTemporalGroupByField(field: string): field is TemporalField {
  return (TEMPORAL_FIELDS as readonly string[]).includes(field);
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

/**
 * Zona horaria IANA ("America/Bogota"). Se inlinea en el SQL (at_timezone no
 * acepta el nombre como parámetro `?` sin desordenar los placeholders), así
 * que se valida con una lista estricta de caracteres Y contra Intl: nunca
 * llega al SQL algo que no sea un nombre de zona real.
 */
const TIME_ZONE_SHAPE = /^[A-Za-z]+(?:[_-][A-Za-z]+)*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length > 64 || !TIME_ZONE_SHAPE.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Sin zona (o UTC) se conserva el comportamiento de siempre: recorte del texto ISO, en UTC. */
function isUtc(timeZone: string | undefined): boolean {
  return !timeZone || timeZone === "UTC" || timeZone === "Etc/UTC";
}

/** Expresión SQL con la fecha local `yyyy-MM-dd` de `capturedat` en esa zona. */
export function localDateExpression(timeZone: string | undefined): string {
  if (isUtc(timeZone)) return "substr(capturedat, 1, 10)";
  return `format_datetime(at_timezone(from_iso8601_timestamp(capturedat), '${timeZone}'), 'yyyy-MM-dd')`;
}

export function groupByExpression(field: GroupByField, timeZone?: string): string {
  if (timeZone !== undefined && !isUtc(timeZone) && !isValidTimeZone(timeZone)) {
    throw new Error(`zona horaria inválida: "${timeZone}"`);
  }
  if (field === "day") return localDateExpression(timeZone);
  if (field === "hour") {
    return isUtc(timeZone)
      ? "replace(substr(capturedat, 1, 13), 'T', ' ')"
      : `format_datetime(at_timezone(from_iso8601_timestamp(capturedat), '${timeZone}'), 'yyyy-MM-dd HH')`;
  }
  return categoricalColumn(field);
}
