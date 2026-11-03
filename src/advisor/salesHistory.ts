import { ATHENA_WORKGROUP } from "../shared/dynamo.js";
import { groupByExpression, isValidTimeZone, localDateExpression } from "../widgets/fields.js";
import { runAthenaRows, type AthenaRow } from "../widgets/athenaQuery.js";
import type { AthenaQuery } from "../widgets/queryBuilder.js";
import { localDate } from "./localTime.js";

// Deben coincidir con `analyticsDatabaseName`/`analyticsTableName` en el stack (y en queryBuilder.ts).
const FROM = "ticket_analytics.ticket_items";

/** Semanas de historial que miran los detectores de venta (mediana del mismo día de la semana). */
export const HISTORY_WEEKS = 8;

/** Tickets sin agente (capturados antes de que existiera el campo, o con la api-key legacy). */
export const UNASSIGNED_AGENT = "unassigned";

const DAY_MS = 86_400_000;

/** Ventas de una hora local y una sucursal. Todo el historial de un tenant cabe en unos pocos miles de estas filas. */
export interface SalesHourRow {
  /** Fecha local yyyy-MM-dd. */
  day: string;
  /** Hora local 0-23. */
  hour: number;
  agentId: string;
  sales: number;
  tickets: number;
}

/**
 * UNA consulta por tenant para todos los detectores de venta: ventas y tickets por hora
 * local y sucursal en las últimas `weeks` semanas. De ahí salen el total diario, el de
 * cada sucursal y las franjas con actividad habitual; nada más consulta Athena.
 *
 * Mismo criterio que los widgets (ver `buildWidgetQuery`): solo ventas, estados `parsed`
 * y `needs_review`, y el total del ticket colapsado a un valor por ticket antes de sumar
 * (la tabla tiene una fila por ítem).
 */
export function buildSalesHistoryQuery(tenantId: string, timeZone: string, now: Date, weeks: number = HISTORY_WEEKS): AthenaQuery {
  if (!isValidTimeZone(timeZone) && timeZone !== "UTC") throw new Error(`zona horaria inválida: "${timeZone}"`);

  const since = new Date(now.getTime() - weeks * 7 * DAY_MS);
  const sinceDate = localDate(since, timeZone);
  // Las particiones son UTC y la fecha local puede caer en el año vecino: ±1 día alcanza para cualquier zona.
  const fromYear = new Date(since.getTime() - DAY_MS).getUTCFullYear();
  const toYear = new Date(now.getTime() + DAY_MS).getUTCFullYear();

  const hourLabel = groupByExpression("hour", timeZone);
  const where =
    "tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) " +
    `AND ${localDateExpression(timeZone)} >= ? ` +
    "AND COALESCE(doctype, 'sale') = 'sale' AND status IN ('parsed', 'needs_review')";

  return {
    sql:
      "SELECT hour_label, agentid, SUM(total) AS sales, COUNT(*) AS tickets FROM (" +
      `SELECT ticketid, agentid, ${hourLabel} AS hour_label, MAX(total) AS total FROM ${FROM} WHERE ${where} ` +
      `GROUP BY ticketid, agentid, ${hourLabel}` +
      ") GROUP BY hour_label, agentid ORDER BY hour_label ASC",
    params: [tenantId, String(fromYear), String(toYear), sinceDate],
  };
}

const HOUR_LABEL = /^(\d{4}-\d{2}-\d{2}) (\d{2})$/;

export function parseSalesHistoryRows(rows: AthenaRow[]): SalesHourRow[] {
  return rows.map((row) => {
    const match = HOUR_LABEL.exec(row.hour_label ?? "");
    const sales = Number(row.sales ?? 0);
    const tickets = Number(row.tickets ?? 0);
    if (!match || !Number.isFinite(sales) || !Number.isFinite(tickets)) {
      throw new Error("Athena devolvió una fila inválida en el historial de ventas");
    }
    return { day: match[1], hour: Number(match[2]), agentId: row.agentid || UNASSIGNED_AGENT, sales, tickets };
  });
}

export async function loadSalesHistory(tenantId: string, timeZone: string, now: Date = new Date(), weeks: number = HISTORY_WEEKS): Promise<SalesHourRow[]> {
  const query = buildSalesHistoryQuery(tenantId, timeZone, now, weeks);
  return parseSalesHistoryRows(await runAthenaRows(query.sql, query.params, ATHENA_WORKGROUP));
}
