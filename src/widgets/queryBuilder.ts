import {
  EVENT_COUNT_FIELD,
  categoricalColumn,
  isValidAggregation,
  isValidGroupByField,
  isValidMetricField,
  numericColumn,
} from "./fields.js";
import type { WidgetRecord } from "../shared/types.js";

// Deben coincidir con `analyticsDatabaseName`/`analyticsTableName` en
// ticket-parsing-cloud-stack.ts.
const ANALYTICS_DATABASE = "ticket_analytics";
const ANALYTICS_TABLE = "ticket_items";

const MAX_GROUPS = 50;

const AGG_SQL: Record<string, string> = { sum: "SUM", avg: "AVG", max: "MAX", min: "MIN", count: "COUNT" };

export interface AthenaQuery {
  sql: string;
  params: string[];
}

/**
 * Arma el SQL de Athena para un widget. Los IDENTIFICADORES (columna de
 * métrica, columna de agrupación) salen únicamente de la lista blanca de
 * `fields.ts` — nunca de un string del usuario concatenado directo, ni
 * siquiera el que ya pasó la validación al guardar el widget (esta función
 * vuelve a validar, es la última línea de defensa antes de generar SQL de
 * verdad). Los VALORES (tenantId, fechas, texto de filtros) viajan como
 * `ExecutionParameters` de Athena (placeholders `?`), nunca interpolados.
 */
export function buildWidgetQuery(widget: WidgetRecord): AthenaQuery {
  if (!isValidMetricField(widget.metric.field)) {
    throw new Error(`campo de métrica inválido: "${widget.metric.field}"`);
  }
  if (!isValidAggregation(widget.metric.aggregation)) {
    throw new Error(`agregación inválida: "${widget.metric.aggregation}"`);
  }
  if (widget.groupBy !== undefined && !isValidGroupByField(widget.groupBy)) {
    throw new Error(`campo de agrupación inválido: "${widget.groupBy}"`);
  }

  // "event_count" cuenta tickets, no filas — la tabla tiene una fila por
  // ÍTEM, así que un ticket con 3 ítems no puede contar como 3 eventos.
  // La agregación elegida no aplica acá, se ignora a propósito.
  const selectExpr =
    widget.metric.field === EVENT_COUNT_FIELD
      ? "COUNT(DISTINCT ticketid)"
      : `${AGG_SQL[widget.metric.aggregation]}(${numericColumn(widget.metric.field)})`;

  const params: string[] = [widget.tenantId];
  const conditions = ["tenant = ?"];

  if (widget.filters?.dateFrom) {
    conditions.push("capturedat >= ?");
    params.push(widget.filters.dateFrom);
  }
  if (widget.filters?.dateTo) {
    conditions.push("capturedat <= ?");
    params.push(widget.filters.dateTo);
  }
  if (widget.filters?.port) {
    conditions.push("port = ?");
    params.push(widget.filters.port);
  }
  if (widget.filters?.status) {
    conditions.push("status = ?");
    params.push(widget.filters.status);
  }

  const whereClause = conditions.join(" AND ");
  const from = `${ANALYTICS_DATABASE}.${ANALYTICS_TABLE}`;

  if (widget.groupBy) {
    const groupColumn = categoricalColumn(widget.groupBy);
    return {
      sql:
        `SELECT ${groupColumn} AS label, ${selectExpr} AS value ` +
        `FROM ${from} WHERE ${whereClause} ` +
        `GROUP BY ${groupColumn} ORDER BY value DESC LIMIT ${MAX_GROUPS}`,
      params,
    };
  }

  return {
    sql: `SELECT ${selectExpr} AS value FROM ${from} WHERE ${whereClause}`,
    params,
  };
}
