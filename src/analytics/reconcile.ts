import type { ParsedTicket } from "../parsing/types.js";
import type { TicketRecord } from "../shared/types.js";
import { analyticsRowKey, buildAnalyticsBody, type AnalyticsTicketContext } from "./writeAnalyticsRows.js";

/**
 * Reconciliación DynamoDB ↔ copia analítica en S3. DynamoDB es la fuente de
 * verdad; la copia analítica es un objeto por ticket en una clave
 * determinística (`analyticsRowKey`), así que comparar es listar claves y
 * contrastar con lo que el ticket guardado dice que debería haber.
 *
 * Todo este módulo es puro (sin I/O): lo usan `scripts/reconcile-analytics.ts`
 * para diagnosticar/reparar y, a futuro, el consumidor que mantiene la copia.
 */

export type ReconTicket = Pick<
  TicketRecord,
  "tenantId" | "ticketId" | "capturedAt" | "port" | "agentId" | "status" | "parsedBy" | "items" | "total" | "tax" | "discount" | "tip"
> &
  Partial<Pick<TicketRecord, "docType" | "customerName" | "customerId" | "purchaseOrder" | "paymentDueDate">>;

/** Estados cuya venta debe contar en las estadísticas. */
const COUNTABLE = new Set<TicketRecord["status"]>(["parsed", "needs_review"]);

export function isCountable(ticket: Pick<TicketRecord, "status">): boolean {
  return COUNTABLE.has(ticket.status);
}

/**
 * Entradas con las que se (re)escribe la copia analítica de un ticket
 * guardado, o `undefined` si no corresponde que tenga filas. Una sola
 * definición para el script de reparación y el flujo normal.
 *
 * Tickets anteriores al campo `parsedBy` solo existían con el parser
 * determinístico, de ahí el valor por defecto.
 */
export function analyticsInputsFromTicket(
  ticket: ReconTicket,
): { ctx: AnalyticsTicketContext; parsed: ParsedTicket } | undefined {
  if (!isCountable(ticket) || !ticket.items || ticket.items.length === 0) return undefined;
  return {
    ctx: {
      tenantId: ticket.tenantId,
      ticketId: ticket.ticketId,
      capturedAt: ticket.capturedAt,
      port: ticket.port,
      agentId: ticket.agentId,
      parsedBy: ticket.parsedBy ?? "deterministic",
      status: ticket.status as "parsed" | "needs_review",
    },
    parsed: {
      items: ticket.items,
      total: ticket.total ?? 0,
      tax: ticket.tax,
      discount: ticket.discount,
      tip: ticket.tip,
      timestamp: ticket.capturedAt,
      docType: ticket.docType,
      customerName: ticket.customerName,
      customerId: ticket.customerId,
      purchaseOrder: ticket.purchaseOrder,
      paymentDueDate: ticket.paymentDueDate,
    },
  };
}

/** Resumen comparable del contenido de un objeto: lo que importa para las estadísticas, sin ruido de formato. */
export interface RowsFingerprint {
  corrupt?: true;
  rowCount: number;
  statuses: string[];
  total: number | null;
  subtotalSum: number;
  tax: number | null;
  discount: number | null;
  tip: number | null;
}

export function fingerprintBody(body: string): RowsFingerprint {
  const statuses = new Set<string>();
  let rowCount = 0;
  let subtotalSum = 0;
  let first: Record<string, unknown> | undefined;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { corrupt: true, rowCount: 0, statuses: [], total: null, subtotalSum: 0, tax: null, discount: null, tip: null };
    }
    first ??= row;
    rowCount += 1;
    statuses.add(String(row.status));
    subtotalSum += Number(row.subtotal) || 0;
  }
  const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
  return {
    rowCount,
    statuses: [...statuses].sort(),
    total: num(first?.total),
    subtotalSum,
    tax: num(first?.tax),
    discount: num(first?.discount),
    tip: num(first?.tip),
  };
}

export interface AnalyticsObject {
  key: string;
  /** Ausente si no se leyó el contenido (modo rápido): solo se compara la existencia. */
  fingerprint?: RowsFingerprint;
}

export type OrphanReason = "discarded" | "failed" | "pending" | "duplicate-key" | "unknown-ticket";

export type Discrepancy =
  | { kind: "missing"; ticketId: string; key: string; ticketStatus: TicketRecord["status"] }
  | { kind: "stale"; ticketId: string; key: string; differences: string[] }
  | { kind: "orphan"; ticketId: string; key: string; reason: OrphanReason };

const EPSILON = 0.005;
const sameNumber = (a: number | null, b: number | null) =>
  a === b || (a !== null && b !== null && Math.abs(a - b) < EPSILON);

function differences(expected: RowsFingerprint, actual: RowsFingerprint): string[] {
  if (actual.corrupt) return ["objeto ilegible (JSON inválido)"];
  const out: string[] = [];
  if (actual.statuses.join() !== expected.statuses.join()) {
    out.push(`estado: analítica=${actual.statuses.join("/") || "-"} guardado=${expected.statuses.join("/")}`);
  }
  if (!sameNumber(actual.total, expected.total)) out.push(`total: analítica=${actual.total} guardado=${expected.total}`);
  if (actual.rowCount !== expected.rowCount) out.push(`ítems: analítica=${actual.rowCount} guardado=${expected.rowCount}`);
  if (!sameNumber(actual.subtotalSum, expected.subtotalSum)) {
    out.push(`suma de subtotales: analítica=${actual.subtotalSum} guardado=${expected.subtotalSum}`);
  }
  for (const field of ["tax", "discount", "tip"] as const) {
    if (!sameNumber(actual[field], expected[field])) out.push(`${field}: analítica=${actual[field]} guardado=${expected[field]}`);
  }
  return out;
}

/**
 * `seed-demo-tenant.ts` agrupa varios tickets en un archivo por sucursal y día
 * (`demo-<sucursal>-<fecha>.jsonl`). La reconciliación asume un objeto por
 * ticket, así que en esos datos da falsos positivos y reparar borraría o
 * duplicaría ventas. Devuelve las claves con ese layout agrupado.
 */
export function batchedDemoKeys(keys: string[]): string[] {
  return keys.filter((key) => /\/demo-[^/]*\.jsonl$/.test(key));
}

const ticketIdFromKey = (key: string) => key.slice(key.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");

/**
 * Compara los tickets guardados con los objetos de analítica.
 * - `missing`: debería haber filas y no hay objeto.
 * - `stale`: hay objeto pero su contenido difiere del ticket (solo si se leyó).
 * - `orphan`: hay objeto que no corresponde a ningún ticket que deba contar
 *   (descartado, fallido, en reproceso, sin ticket, o en una clave distinta a
 *   la que le toca → duplicaría la venta).
 */
export function diffAnalytics(tickets: ReconTicket[], objects: AnalyticsObject[]): Discrepancy[] {
  const byId = new Map(tickets.map((t) => [t.ticketId, t]));
  const objectByKey = new Map(objects.map((o) => [o.key, o]));
  const expectedKeys = new Set<string>();
  const out: Discrepancy[] = [];

  for (const ticket of tickets) {
    if (!isCountable(ticket)) continue;
    const key = analyticsRowKey(ticket.tenantId, ticket.capturedAt, ticket.ticketId);
    expectedKeys.add(key);
    const inputs = analyticsInputsFromTicket(ticket);
    if (!inputs) continue; // sin ítems: el objeto puede existir (vacío) o no, ambos son válidos
    const object = objectByKey.get(key);
    if (!object) {
      out.push({ kind: "missing", ticketId: ticket.ticketId, key, ticketStatus: ticket.status });
      continue;
    }
    if (!object.fingerprint) continue;
    const diff = differences(fingerprintBody(buildAnalyticsBody(inputs.ctx, inputs.parsed)), object.fingerprint);
    if (diff.length > 0) out.push({ kind: "stale", ticketId: ticket.ticketId, key, differences: diff });
  }

  for (const object of objects) {
    if (expectedKeys.has(object.key)) continue;
    const ticketId = ticketIdFromKey(object.key);
    const ticket = byId.get(ticketId);
    const reason: OrphanReason = !ticket
      ? "unknown-ticket"
      : isCountable(ticket)
        ? "duplicate-key"
        : (ticket.status as "discarded" | "failed" | "pending");
    out.push({ kind: "orphan", ticketId, key: object.key, reason });
  }

  return out;
}
