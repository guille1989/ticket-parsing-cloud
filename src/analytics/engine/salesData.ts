import { ATHENA_WORKGROUP } from "../../shared/dynamo.js";
import { isValidTimeZone, localDateExpression } from "../../widgets/fields.js";
import { runAthenaRows, type AthenaRow } from "../../widgets/athenaQuery.js";
import type { AthenaQuery } from "../../widgets/queryBuilder.js";
import { LOOKBACK_WEEKS } from "./compare.js";
import { addDays, localDate } from "./time.js";
import { UNASSIGNED_AGENT, type SalesSlotRow } from "./types.js";

// Deben coincidir con `analyticsDatabaseName`/`analyticsTableName` en el stack (y en queryBuilder.ts).
const FROM = "ticket_analytics.ticket_items";

/** Ventana de historial: 8 semanas alcanzan para 4 mismos días válidos aun con cierres o caídas de captura. */
export const SALES_HISTORY_DAYS = LOOKBACK_WEEKS * 7 + 7;

function zoned(timeZone: string): string {
  return `at_timezone(from_iso8601_timestamp(capturedat), '${timeZone}')`;
}

/**
 * Etiqueta "yyyy-MM-dd HH:00" o "yyyy-MM-dd HH:30" de la franja de media hora local del ticket.
 * La zona se inlinea en el SQL (at_timezone no admite `?`), por eso se valida antes.
 */
function slotExpression(timeZone: string): string {
  const z = zoned(timeZone);
  return `concat(format_datetime(${z}, 'yyyy-MM-dd HH:'), CASE WHEN minute(${z}) >= 30 THEN '30' ELSE '00' END)`;
}

/**
 * UNA consulta por tenant con las ventas por franja de media hora y sucursal de los últimos
 * ~2 meses. De ahí salen hoy, los días de referencia y cada sucursal. Mismo criterio que los
 * widgets: solo ventas, estados `parsed` y `needs_review`, total del ticket colapsado a un valor
 * por ticket antes de sumar (la tabla tiene una fila por ítem). El tenant viaja como parámetro.
 */
export function buildSalesSlotsQuery(tenantId: string, timeZone: string, now: Date, days: number = SALES_HISTORY_DAYS): AthenaQuery {
  if (!isValidTimeZone(timeZone)) throw new Error(`zona horaria inválida: "${timeZone}"`);
  const sinceDate = addDays(localDate(now, timeZone), -days);
  // Las particiones son UTC y la fecha local puede caer en el año vecino: ±1 día alcanza para cualquier zona.
  const fromYear = new Date(`${addDays(sinceDate, -1)}T00:00:00Z`).getUTCFullYear();
  const toYear = new Date(now.getTime() + 86_400_000).getUTCFullYear();

  const slot = slotExpression(timeZone);
  const where =
    "tenant = ? AND CAST(year AS VARCHAR) >= CAST(? AS VARCHAR) AND CAST(year AS VARCHAR) <= CAST(? AS VARCHAR) " +
    `AND ${localDateExpression(timeZone)} >= ? ` +
    "AND COALESCE(doctype, 'sale') = 'sale' AND status IN ('parsed', 'needs_review')";

  return {
    sql:
      "SELECT slot_label, agentid, SUM(total) AS sales, COUNT(*) AS tickets FROM (" +
      `SELECT ticketid, agentid, ${slot} AS slot_label, MAX(total) AS total FROM ${FROM} WHERE ${where} ` +
      `GROUP BY ticketid, agentid, ${slot}` +
      ") GROUP BY slot_label, agentid ORDER BY slot_label ASC",
    params: [tenantId, String(fromYear), String(toYear), sinceDate],
  };
}

const SLOT_LABEL = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(00|30)$/;

export function parseSalesSlotRows(rows: AthenaRow[]): SalesSlotRow[] {
  return rows.map((row) => {
    const match = SLOT_LABEL.exec(row.slot_label ?? "");
    const sales = Number(row.sales ?? 0);
    const tickets = Number(row.tickets ?? 0);
    if (!match || !Number.isFinite(sales) || !Number.isFinite(tickets)) {
      throw new Error("Athena devolvió una fila inválida en las ventas por franja");
    }
    return {
      day: match[1],
      slot: Number(match[2]) * 2 + (match[3] === "30" ? 1 : 0),
      agentId: row.agentid || UNASSIGNED_AGENT,
      sales,
      tickets,
    };
  });
}

export async function loadSalesSlots(tenantId: string, timeZone: string, now: Date = new Date(), maxWaitMs?: number): Promise<SalesSlotRow[]> {
  const query = buildSalesSlotsQuery(tenantId, timeZone, now);
  return parseSalesSlotRows(await runAthenaRows(query.sql, query.params, ATHENA_WORKGROUP, maxWaitMs));
}
