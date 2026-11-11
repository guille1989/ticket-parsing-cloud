import { ATHENA_WORKGROUP } from "../../shared/dynamo.js";
import { isValidTimeZone, localDateExpression } from "../../widgets/fields.js";
import { runAthenaRows, type AthenaRow } from "../../widgets/athenaQuery.js";
import type { AthenaQuery } from "../../widgets/queryBuilder.js";
import { addDays, localDate } from "./time.js";
import type { ProductRow } from "./types.js";

const FROM = "ticket_analytics.ticket_items";

export const DEFAULT_STAR_DAYS = 30;
export const MIN_STAR_DAYS = 7;
export const MAX_STAR_DAYS = 90;
/** Tope de filas (producto × periodo) que se traen; si se alcanza, el análisis avisa que es parcial. */
export const PRODUCT_ROW_LIMIT = 2000;

export interface ProductWindow {
  currentFrom: string;
  currentTo: string;
  previousFrom: string;
  previousTo: string;
}

/**
 * `days` días COMPLETOS (sin hoy, que es un día parcial) frente a los `days` anteriores: el ranking
 * del día en curso no se confunde con el estructural.
 */
export function productWindow(now: Date, timeZone: string, days: number): ProductWindow {
  const today = localDate(now, timeZone);
  return {
    currentFrom: addDays(today, -days),
    currentTo: addDays(today, -1),
    previousFrom: addDays(today, -2 * days),
    previousTo: addDays(today, -days - 1),
  };
}

/**
 * Ingresos y unidades por producto en los dos periodos, sin líneas anuladas. Los parámetros viajan
 * en orden de aparición de los `?`: primero el del CASE de la sub-consulta.
 */
export function buildProductQuery(tenantId: string, timeZone: string, now: Date, days: number, agentId?: string): AthenaQuery {
  if (!isValidTimeZone(timeZone)) throw new Error(`zona horaria inválida: "${timeZone}"`);
  return buildProductWindowQuery(tenantId, timeZone, now, productWindow(now, timeZone, days), agentId);
}

/**
 * Igual, para dos ventanas arbitrarias (p. ej. semana en curso vs. semana anterior). Los días que quedan
 * entre ambas ventanas se excluyen: no son "actual" ni "anterior".
 */
export function buildProductWindowQuery(tenantId: string, timeZone: string, now: Date, window: ProductWindow, agentId?: string): AthenaQuery {
  if (!isValidTimeZone(timeZone)) throw new Error(`zona horaria inválida: "${timeZone}"`);
  const date = localDateExpression(timeZone);
  const fromYear = new Date(`${addDays(window.previousFrom, -1)}T00:00:00Z`).getUTCFullYear();
  const toYear = new Date(now.getTime() + 86_400_000).getUTCFullYear();

  const params = [window.currentFrom, tenantId, String(fromYear), String(toYear), window.previousFrom, window.currentTo, window.currentFrom, window.previousTo];
  let where =
    "tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) " +
    `AND ${date} >= ? AND ${date} <= ? AND (${date} >= ? OR ${date} <= ?) ` +
    "AND COALESCE(doctype, 'sale') = 'sale' AND status IN ('parsed', 'needs_review') AND COALESCE(voided, false) = false";
  if (agentId) {
    where += " AND agentid = ?";
    params.push(agentId);
  }

  return {
    sql:
      "SELECT description, period, SUM(subtotal) AS revenue, SUM(quantity) AS units FROM (" +
      `SELECT COALESCE(description, '(sin dato)') AS description, CASE WHEN ${date} >= ? THEN 'current' ELSE 'previous' END AS period, ` +
      `subtotal, quantity FROM ${FROM} WHERE ${where}` +
      `) GROUP BY description, period ORDER BY revenue DESC LIMIT ${PRODUCT_ROW_LIMIT}`,
    params,
  };
}

/**
 * Productos vendidos en fechas locales puntuales (los mismos días de la semana del pasado). Todas las
 * filas salen como periodo "current". Las fechas viajan como parámetros, una por `?`.
 */
export function buildProductDatesQuery(tenantId: string, timeZone: string, now: Date, dates: string[], agentId?: string): AthenaQuery {
  if (!isValidTimeZone(timeZone)) throw new Error(`zona horaria inválida: "${timeZone}"`);
  if (dates.length === 0 || dates.length > 20) throw new Error("se esperaban entre 1 y 20 fechas");
  const date = localDateExpression(timeZone);
  const sorted = [...dates].sort();
  const fromYear = new Date(`${addDays(sorted[0], -1)}T00:00:00Z`).getUTCFullYear();
  const toYear = new Date(now.getTime() + 86_400_000).getUTCFullYear();
  const params = [tenantId, String(fromYear), String(toYear), ...dates];
  let where =
    "tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) " +
    `AND ${date} IN (${dates.map(() => "?").join(", ")}) ` +
    "AND COALESCE(doctype, 'sale') = 'sale' AND status IN ('parsed', 'needs_review') AND COALESCE(voided, false) = false";
  if (agentId) {
    where += " AND agentid = ?";
    params.push(agentId);
  }
  return {
    sql:
      "SELECT COALESCE(description, '(sin dato)') AS description, 'current' AS period, SUM(subtotal) AS revenue, SUM(quantity) AS units " +
      `FROM ${FROM} WHERE ${where} GROUP BY COALESCE(description, '(sin dato)') ORDER BY units DESC LIMIT ${PRODUCT_ROW_LIMIT}`,
    params,
  };
}

export async function loadProductRowsForDates(
  tenantId: string,
  timeZone: string,
  now: Date,
  dates: string[],
  agentId?: string,
  maxWaitMs?: number,
): Promise<ProductRow[]> {
  const query = buildProductDatesQuery(tenantId, timeZone, now, dates, agentId);
  return parseProductRows(await runAthenaRows(query.sql, query.params, ATHENA_WORKGROUP, maxWaitMs));
}

export function parseProductRows(rows: AthenaRow[]): ProductRow[] {
  return rows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const units = Number(row.units ?? 0);
    if ((row.period !== "current" && row.period !== "previous") || !Number.isFinite(revenue) || !Number.isFinite(units)) {
      throw new Error("Athena devolvió una fila inválida en los productos");
    }
    return { description: row.description ?? "(sin dato)", period: row.period, revenue, units };
  });
}

export async function loadProductRows(
  tenantId: string,
  timeZone: string,
  now: Date,
  days: number,
  agentId?: string,
  maxWaitMs?: number,
): Promise<ProductRow[]> {
  const query = buildProductQuery(tenantId, timeZone, now, days, agentId);
  return parseProductRows(await runAthenaRows(query.sql, query.params, ATHENA_WORKGROUP, maxWaitMs));
}

export async function loadProductRowsForWindow(
  tenantId: string,
  timeZone: string,
  now: Date,
  window: ProductWindow,
  agentId?: string,
  maxWaitMs?: number,
): Promise<ProductRow[]> {
  const query = buildProductWindowQuery(tenantId, timeZone, now, window, agentId);
  return parseProductRows(await runAthenaRows(query.sql, query.params, ATHENA_WORKGROUP, maxWaitMs));
}
