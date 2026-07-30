import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { ParsedTicket } from "../parsing/types.js";
import type { TicketRecord } from "../shared/types.js";

const s3 = new S3Client({});

export interface AnalyticsTicketContext {
  tenantId: string;
  ticketId: string;
  capturedAt: string;
  port: string;
  parsedBy: NonNullable<TicketRecord["parsedBy"]>;
  status: "parsed" | "needs_review";
}

/**
 * Escribe una fila por ítem del ticket a S3, en el layout particionado
 * (tenant=/year=/month=/day=/) que espera la tabla de Glue con partition
 * projection — ver `ticket-parsing-cloud-stack.ts`. Es una copia aplanada
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
  const capturedAt = new Date(ctx.capturedAt);
  const year = capturedAt.getUTCFullYear();
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(capturedAt.getUTCDate()).padStart(2, "0");

  const rows = parsed.items.map((item) =>
    JSON.stringify({
      tenantId: ctx.tenantId,
      ticketId: ctx.ticketId,
      capturedAt: ctx.capturedAt,
      port: ctx.port,
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
      total: parsed.total,
    }),
  );

  const key = `tenant=${ctx.tenantId}/year=${year}/month=${month}/day=${day}/${ctx.ticketId}.jsonl`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: rows.join("\n") + "\n",
      ContentType: "application/x-ndjson",
    }),
  );
}
