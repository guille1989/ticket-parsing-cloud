import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { ParsedTicket } from "../parsing/types.js";
import type { TicketRecord } from "../shared/types.js";

const s3 = new S3Client({});

/**
 * La misma key que arma `writeAnalyticsRows` para un ticket — expuesta
 * aparte porque `review/handler.ts` la necesita para borrar la fila de un
 * ticket descartado (`DeleteObjectCommand`) sin duplicar la lógica de
 * partición año/mes.
 */
export function analyticsRowKey(tenantId: string, capturedAt: string, ticketId: string): string {
  const parsed = new Date(capturedAt);
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `tenant=${tenantId}/year=${year}/month=${month}/${ticketId}.jsonl`;
}

export interface AnalyticsTicketContext {
  tenantId: string;
  ticketId: string;
  capturedAt: string;
  port: string;
  /** Ver `TicketRecord.agentId` — ausente para tickets subidos con la api-key compartida legacy. */
  agentId?: string;
  parsedBy: NonNullable<TicketRecord["parsedBy"]>;
  status: "parsed" | "needs_review";
}

/**
 * Escribe una fila por ítem del ticket a S3, en el layout particionado
 * (tenant=/year=/month=/) que espera la tabla de Glue con partition
 * projection — ver `ticket-parsing-cloud-stack.ts`. Sin partición por día
 * a propósito (ver comentario ahí) — el dato de fecha exacta sigue en la
 * columna `capturedat` de cada fila. Es una copia aplanada
 * de solo lectura para Athena, no reemplaza a DynamoDB: sigue siendo la
 * fuente de verdad operacional, esto es solo para agregaciones/reportes.
 *
 * Una fila por ítem (no una por ticket) para poder hacer
 * `SUM(subtotal) WHERE description = 'X'` cruzando todos los tickets, algo
 * que DynamoDB no hace bien con `items` anidado dentro de un solo registro.
 */
export async function writeAnalyticsRows(
  bucket: string,
  ctx: AnalyticsTicketContext,
  parsed: ParsedTicket,
): Promise<void> {
  const rows = parsed.items.map((item) =>
    JSON.stringify({
      tenantId: ctx.tenantId,
      ticketId: ctx.ticketId,
      capturedAt: ctx.capturedAt,
      port: ctx.port,
      agentId: ctx.agentId ?? null,
      status: ctx.status,
      parsedBy: ctx.parsedBy,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      voided: item.voided ?? false,
      // Denormalizado a propósito: el nivel de agregación que interesa acá
      // es el ítem, así que se repite el dato de ticket en cada fila en vez
      // de forzar un join contra otra tabla para poder promediar/filtrar.
      discount: parsed.discount ?? null,
      tip: parsed.tip ?? null,
      tax: parsed.tax ?? null,
      total: parsed.total,
    }),
  );

  const key = analyticsRowKey(ctx.tenantId, ctx.capturedAt, ctx.ticketId);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: rows.join("\n") + "\n",
      ContentType: "application/x-ndjson",
    }),
  );
}
