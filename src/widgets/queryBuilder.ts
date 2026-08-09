import {
  EVENT_COUNT_FIELD,
  categoricalColumn,
  isTicketLevelField,
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
  // "total"/"discount"/"tip" son del ticket, no del ítem — no hay forma
  // correcta de repartirlos entre las descripciones de un mismo ticket.
  // Para desglosar por producto existe "subtotal", que sí es por ítem.
  if (widget.groupBy === "description" && isTicketLevelField(widget.metric.field)) {
    throw new Error(
      `no se puede agrupar "${widget.metric.field}" (un valor por ticket) por "description" (un valor por ítem) — usá "subtotal" para desglosar por producto`,
    );
  }

  const { whereClause, params } = buildWhere(widget);
  const from = `${ANALYTICS_DATABASE}.${ANALYTICS_TABLE}`;

  // "event_count" cuenta tickets, no filas — la tabla tiene una fila por
  // ÍTEM, así que un ticket con 3 ítems no puede contar como 3 eventos. La
  // agregación elegida no aplica acá, se ignora a propósito.
  if (widget.metric.field === EVENT_COUNT_FIELD) {
    return buildDirectQuery(from, whereClause, params, "COUNT(DISTINCT ticketid)", widget.groupBy);
  }

  const column = numericColumn(widget.metric.field);
  const aggSql = AGG_SQL[widget.metric.aggregation];

  // total/discount/tip vienen repetidos en cada fila del ticket al que
  // pertenecen (ver `fields.ts`) — sumarlos/promediarlos directo cuenta esa
  // repetición una vez por ítem. Se resuelve colapsando a un valor por
  // ticket ANTES de agregar: MAX(columna) agrupado por ticketid da lo
  // mismo que el valor único ya que está duplicado, así que no altera el
  // dato, solo elimina las copias antes de que la agregación de afuera las
  // vuelva a contar.
  if (isTicketLevelField(widget.metric.field)) {
    return buildTicketLevelQuery(from, whereClause, params, column, aggSql, widget.groupBy);
  }

  return buildDirectQuery(from, whereClause, params, `${aggSql}(${column})`, widget.groupBy);
}

// `capturedat` (usado en los filtros de fecha de abajo) es una columna
// normal, no una de partición — filtrar solo por ella no le dice nada a
// Athena sobre qué particiones puede saltear. Sin acotar `year` (columna
// de partición de verdad), la proyección declarada en el stack
// (2024-2035 × 12 meses — ver `analyticsTable` en
// ticket-parsing-cloud-stack.ts) obliga a Athena a barrer ~140
// particiones por tenant así no haya un tenant nuevo con un solo ticket
// de hoy — eso fue justo lo que causó el timeout de 20s la primera vez
// que se probó un widget de verdad. (Hasta 2026-08-09 también existía
// partición por día, que multiplicaba esto x31 — ver PROYECTO.md sección
// 10.1 sobre el costo de S3 que generó.)
//
// `CAST(year AS VARCHAR)`, no `year` a secas: la tabla de Glue declara la
// columna `year` como `string` (`partitionKeys` en el stack), pero la
// proyección de particiones la define con `"projection.year.type":
// "integer"` — Athena arma el plan de la consulta según ESE tipo
// proyectado. Y el CAST hace falta en LOS DOS lados: los `?` de
// `ExecutionParameters` no viajan como varchar solo por estar declarados
// como `string[]` acá — Athena infiere el tipo de cada parámetro por su
// forma literal ("2025" se infiere como integer, con CAST o sin él del
// otro lado), así que sin castear el parámetro también tira
// `TYPE_MISMATCH: Cannot apply operator: varchar <= integer` igual.
// Confirmado reproduciendo el mismo `EXECUTE ... USING` que usa el Lambda
// (vía `--execution-parameters` sin comillas) contra Athena real.
const DEFAULT_YEAR_LOOKBACK = 1;

function buildWhere(widget: WidgetRecord): { whereClause: string; params: string[] } {
  const params: string[] = [widget.tenantId];
  const conditions = ["tenant = ?"];

  const fromYear = widget.filters?.dateFrom
    ? new Date(widget.filters.dateFrom).getUTCFullYear()
    : new Date().getUTCFullYear() - DEFAULT_YEAR_LOOKBACK;
  const toYear = widget.filters?.dateTo ? new Date(widget.filters.dateTo).getUTCFullYear() : new Date().getUTCFullYear();
  conditions.push("CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR)");
  params.push(String(fromYear), String(toYear));

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

  return { whereClause: conditions.join(" AND "), params };
}

/** Métricas por ítem (quantity/unitPrice/subtotal) y event_count: se agregan directo, sin sub-consulta. */
function buildDirectQuery(
  from: string,
  whereClause: string,
  params: string[],
  selectExpr: string,
  groupBy: string | undefined,
): AthenaQuery {
  if (!groupBy) {
    return { sql: `SELECT ${selectExpr} AS value FROM ${from} WHERE ${whereClause}`, params };
  }
  const groupColumn = categoricalColumn(groupBy as never);
  return {
    sql:
      `SELECT ${groupColumn} AS label, ${selectExpr} AS value ` +
      `FROM ${from} WHERE ${whereClause} ` +
      `GROUP BY ${groupColumn} ORDER BY value DESC LIMIT ${MAX_GROUPS}`,
    params,
  };
}

/** Métricas de ticket (total/discount/tip): colapsa por ticket en una sub-consulta antes de agregar. */
function buildTicketLevelQuery(
  from: string,
  whereClause: string,
  params: string[],
  column: string,
  aggSql: string,
  groupBy: string | undefined,
): AthenaQuery {
  if (!groupBy) {
    const inner = `SELECT ticketid, MAX(${column}) AS ${column} FROM ${from} WHERE ${whereClause} GROUP BY ticketid`;
    return { sql: `SELECT ${aggSql}(${column}) AS value FROM (${inner})`, params };
  }

  const groupColumn = categoricalColumn(groupBy as never);
  const inner =
    `SELECT ticketid, ${groupColumn}, MAX(${column}) AS ${column} ` +
    `FROM ${from} WHERE ${whereClause} GROUP BY ticketid, ${groupColumn}`;
  return {
    sql:
      `SELECT ${groupColumn} AS label, ${aggSql}(${column}) AS value FROM (${inner}) ` +
      `GROUP BY ${groupColumn} ORDER BY value DESC LIMIT ${MAX_GROUPS}`,
    params,
  };
}
