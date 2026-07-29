import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";

import { tryBedrockFallback } from "../parsing/bedrockFallback.js";
import { checkEconomicCoherence } from "../parsing/economicCoherence.js";
import { getParser } from "../parsing/registry.js";
import type { ParsedTicket } from "../parsing/types.js";
import { ddb, RAW_BUCKET, ticketKey, ticketStatusGsiKey, TICKETS_TABLE } from "../shared/dynamo.js";
import { getTenant } from "../shared/tenant.js";
import { ParseJobMessage, TicketRecord } from "../shared/types.js";

const s3 = new S3Client({});

/**
 * Dispara directo del Stream de la tabla Tickets — ver el comentario en
 * `ticket-parsing-cloud-stack.ts` sobre por qué no hay una cola SQS
 * intermedia entre `ingest` y este Lambda.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      // Error transitorio (S3/DynamoDB caído, throttling, etc.) — dejamos
      // que el event source mapping reintente este registro puntual y
      // eventualmente lo mande a la DLQ si sigue fallando.
      console.error(`[parser] error transitorio en registro ${record.dynamodb?.SequenceNumber}:`, err);
      if (record.dynamodb?.SequenceNumber) {
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
  }

  return { batchItemFailures };
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Solo tickets nuevos sin procesar todavía. Un MODIFY (ej. cuando este
  // mismo Lambda actualiza el ticket a parsed/failed más abajo) no tiene
  // que volver a dispararse a sí mismo.
  if (record.eventName !== "INSERT" || !record.dynamodb?.NewImage) return;

  const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as TicketRecord;
  if (item.status !== "pending") return;

  const message: ParseJobMessage = {
    tenantId: item.tenantId,
    ticketId: item.ticketId,
    capturedAt: item.capturedAt,
    rawS3Key: item.rawS3Key,
    port: item.port,
  };

  const tenant = await getTenant(message.tenantId);
  if (!tenant) {
    // No es transitorio: el tenant no existe (se borró, o el mensaje está
    // corrompido). Reintentar no lo va a arreglar — se marca fallido y se
    // consume el mensaje.
    await markFailed(message, "tenant no encontrado");
    return;
  }

  const parserId = tenant.portParsers?.[message.port] ?? tenant.parserId;
  const parser = getParser(parserId);
  if (!parser) {
    await markFailed(message, `parser desconocido: ${parserId}`);
    return;
  }

  const raw = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: message.rawS3Key }));
  const rawText = (await raw.Body?.transformToString()) ?? "";

  // Ninguno de los dos caminos de parseo verifica que sus propios números
  // cierren entre sí — un total inventado (por regex mal armado, o por
  // Bedrock alucinando) pasaría igual como "parsed" sin este chequeo. Si el
  // determinístico da un resultado incoherente, se intenta igual con
  // Bedrock antes de rendirse (ver `parsing/economicCoherence.ts`).
  const deterministic = coherentOrNull(parser.parse(rawText));
  let parsed = deterministic.ticket;
  let parsedBy: NonNullable<TicketRecord["parsedBy"]> = "deterministic";
  let incoherenceReason = deterministic.incoherenceReason;

  // Leído acá (no a nivel de módulo) para que quede desactivado con solo no
  // setear la variable (tests, o mientras no se habilite Bedrock) sin
  // depender de cuándo se importa este archivo.
  const bedrockModelId = process.env.BEDROCK_MODEL_ID;
  if (!parsed && bedrockModelId) {
    const fallback = coherentOrNull(await tryBedrockFallback(rawText, bedrockModelId));
    parsed = fallback.ticket;
    parsedBy = "bedrock-fallback";
    if (fallback.incoherenceReason) incoherenceReason = fallback.incoherenceReason;
  }

  if (!parsed) {
    const reason = incoherenceReason
      ? `el resultado del parseo no es económicamente coherente: ${incoherenceReason}`
      : bedrockModelId
        ? `ni el parser "${parserId}" ni el fallback de Bedrock pudieron extraer un ticket válido`
        : `el parser "${parserId}" no pudo extraer un ticket válido`;
    await markFailed(message, reason);
    return;
  }

  // El determinístico es el único camino que llega a "parsed" directo — un
  // LLM puede alucinar de forma internamente consistente (números que
  // cierran entre sí pero no reflejan el ticket real), así que todo lo que
  // resuelve Bedrock queda pendiente de revisión humana hasta medir
  // precisión real. El mecanismo para promover needs_review -> parsed (o
  // rechazar) queda pendiente, no existe todavía.
  const status: "parsed" | "needs_review" = parsedBy === "deterministic" ? "parsed" : "needs_review";
  await markParsed(message, parsed, parsedBy, status);
}

function coherentOrNull(candidate: ParsedTicket | null): { ticket: ParsedTicket | null; incoherenceReason?: string } {
  if (!candidate) return { ticket: null };
  const coherence = checkEconomicCoherence(candidate);
  return coherence.ok ? { ticket: candidate } : { ticket: null, incoherenceReason: coherence.reason };
}

async function markParsed(
  message: ParseJobMessage,
  parsed: ParsedTicket,
  parsedBy: NonNullable<TicketRecord["parsedBy"]>,
  status: "parsed" | "needs_review",
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: ticketKey(message.tenantId, message.capturedAt, message.ticketId),
      UpdateExpression:
        "SET #status = :status, parsedAt = :parsedAt, #items = :items, #total = :total, discount = :discount, tip = :tip, parsedBy = :parsedBy, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#status": "status", "#total": "total", "#items": "items" },
      ExpressionAttributeValues: {
        ":status": status,
        ":parsedAt": new Date().toISOString(),
        ":items": parsed.items,
        ":total": parsed.total,
        ":discount": parsed.discount ?? null,
        ":tip": parsed.tip ?? null,
        ":parsedBy": parsedBy,
        ...prefixed(ticketStatusGsiKey(message.tenantId, status, message.capturedAt)),
      },
    }),
  );
}

async function markFailed(message: ParseJobMessage, reason: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: ticketKey(message.tenantId, message.capturedAt, message.ticketId),
      UpdateExpression: "SET #status = :status, failReason = :reason, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":reason": reason,
        ...prefixed(ticketStatusGsiKey(message.tenantId, "failed", message.capturedAt)),
      },
    }),
  );
}

function prefixed(gsiKey: { gsi1pk: string; gsi1sk: string }) {
  return { ":gsi1pk": gsiKey.gsi1pk, ":gsi1sk": gsiKey.gsi1sk };
}
