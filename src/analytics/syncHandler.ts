import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";

import { ANALYTICS_BUCKET, ddb, TICKETS_TABLE } from "../shared/dynamo.js";
import { analyticsInputsFromTicket, type ReconTicket } from "./reconcile.js";
import { deleteAnalyticsRows, writeAnalyticsRows } from "./writeAnalyticsRows.js";

/**
 * Único escritor de la copia analítica (S3/Athena). Se suscribe al Stream de
 * la tabla Tickets, aparte del parser, para que reparar una escritura fallida
 * no obligue a repetir el OCR/IA, y para que haya un solo camino de escritura.
 *
 * No confía en el contenido del evento: por cada cambio de un ticket vuelve a
 * leer su estado VIGENTE en DynamoDB y deja la analítica igual a ese estado:
 *   - cuenta (parsed / needs_review, con ítems) → escribe su objeto;
 *   - no cuenta (descartado, fallido, pendiente) o ya no existe → lo borra.
 * Las dos operaciones son idempotentes (clave determinística), así que un evento
 * repetido no duplica ventas, y un evento viejo que se recupera tarde no
 * restaura información desactualizada.
 *
 * Si S3 o DynamoDB fallan, el registro se reporta como fallido: el event source
 * mapping lo reintenta y, agotados los reintentos, lo manda a la DLQ de
 * sincronización (con alarma). La recuperación manual es
 * `npm run reconcile-analytics -- <tenantId> --apply`.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(`[analytics-sync] fallo en registro ${record.dynamodb?.SequenceNumber}:`, err);
      if (record.dynamodb?.SequenceNumber) {
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
  }

  return { batchItemFailures };
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  if (!record.dynamodb?.Keys) return;
  const keys = unmarshall(record.dynamodb.Keys as Record<string, AttributeValue>) as { pk?: string; sk?: string };

  // Los marcadores de deduplicación (`DEDUP#`) comparten tabla y stream con los tickets.
  if (!keys.pk?.startsWith("TENANT#") || !keys.sk?.startsWith("TICKET#")) return;

  const tenantId = keys.pk.slice("TENANT#".length);
  const [capturedAt, ...rest] = keys.sk.slice("TICKET#".length).split("#");
  const ticketId = rest.join("#");
  if (!tenantId || !capturedAt || !ticketId) return;

  const current = await ddb.send(
    new GetCommand({ TableName: TICKETS_TABLE, Key: { pk: keys.pk, sk: keys.sk }, ConsistentRead: true }),
  );
  const inputs = current.Item ? analyticsInputsFromTicket(current.Item as ReconTicket) : undefined;

  if (inputs) {
    await writeAnalyticsRows(ANALYTICS_BUCKET, inputs.ctx, inputs.parsed);
    console.log(`[analytics-sync] escrito ${tenantId}/${ticketId} (${inputs.ctx.status})`);
  } else {
    await deleteAnalyticsRows(ANALYTICS_BUCKET, tenantId, capturedAt, ticketId);
    console.log(`[analytics-sync] sin filas ${tenantId}/${ticketId} (${current.Item?.status ?? "inexistente"})`);
  }
}
