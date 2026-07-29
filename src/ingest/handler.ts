import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { ddb, RAW_BUCKET, ticketKey, ticketStatusGsiKey, TICKETS_TABLE } from "../shared/dynamo.js";
import { resolveTenantByApiKeyId } from "../shared/tenant.js";
import { TicketRecord } from "../shared/types.js";

const s3 = new S3Client({});

interface RawTicketBody {
  ticketId: string;
  port: string;
  capturedAt: string;
  rawText: string;
}

// `ticketId` termina siendo parte de la key de S3 (`tenants/<id>/<ticketId>.txt`)
// y del sort key de DynamoDB — exigir forma de UUID (lo que ya genera el
// agente) evita cualquier chance de path traversal o de romper esas claves
// con caracteres raros.
const TICKET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `port` se usa como key de un diccionario (`Tenants.portParsers`) y queda
// guardado tal cual — alcanza con identificadores tipo COM3, LPT1, o un id
// lógico de periférico TCP (`datafono-caja1`).
const PORT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_PORT_LENGTH = 64;
// El mismo formato que produce `new Date().toISOString()` — es lo único
// que manda el agente. `capturedAt` compone el sort key de DynamoDB
// (`TICKET#<capturedAt>#<ticketId>`), así que una fecha inválida rompe el
// orden cronológico de todo el tenant, no solo este ticket.
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Ninguna impresora térmica genera un ticket ni remotamente cerca de esto
// — es una cota generosa para no bloquear un caso real, pero sí evitar
// que un body gigante llegue a escribirse en S3.
const MAX_RAW_TEXT_BYTES = 64 * 1024;

type BodyValidation = { ok: true; value: RawTicketBody } | { ok: false; error: string };

export function validateBody(body: unknown): BodyValidation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.ticketId !== "string" || !TICKET_ID_PATTERN.test(b.ticketId)) {
    return { ok: false, error: "ticketId inválido, se esperaba un UUID" };
  }
  if (
    typeof b.port !== "string" ||
    b.port.length === 0 ||
    b.port.length > MAX_PORT_LENGTH ||
    !PORT_PATTERN.test(b.port)
  ) {
    return {
      ok: false,
      error: `port inválido (máx ${MAX_PORT_LENGTH} caracteres; solo letras, números, "_", "." o "-")`,
    };
  }
  if (typeof b.capturedAt !== "string" || !ISO_8601_PATTERN.test(b.capturedAt) || Number.isNaN(Date.parse(b.capturedAt))) {
    return { ok: false, error: "capturedAt inválido, se esperaba ISO-8601 (ej. 2026-07-27T12:00:00.000Z)" };
  }
  if (typeof b.rawText !== "string" || b.rawText.length === 0) {
    return { ok: false, error: "rawText inválido, se esperaba texto no vacío" };
  }
  const rawTextBytes = Buffer.byteLength(b.rawText, "utf-8");
  if (rawTextBytes > MAX_RAW_TEXT_BYTES) {
    return { ok: false, error: `rawText demasiado grande (máx ${MAX_RAW_TEXT_BYTES} bytes, recibidos ${rawTextBytes})` };
  }

  return { ok: true, value: { ticketId: b.ticketId, port: b.port, capturedAt: b.capturedAt, rawText: b.rawText } };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity?.apiKeyId;
  if (!apiKeyId) {
    return { statusCode: 403, body: JSON.stringify({ error: "falta API key" }) };
  }

  const tenant = await resolveTenantByApiKeyId(apiKeyId);
  if (!tenant) {
    return { statusCode: 403, body: JSON.stringify({ error: "API key no asociada a ningún tenant" }) };
  }

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "body inválido, se esperaba JSON" }) };
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return { statusCode: 400, body: JSON.stringify({ error: validation.error }) };
  }
  const validBody = validation.value;

  // El ticketId lo genera el AGENTE, no acá — así un reintento (el agente
  // no sabe si un fallo de red pasó antes o después de que el servidor
  // procesara el pedido) manda el mismo id, y la escritura condicional de
  // abajo lo detecta como duplicado en vez de crear un ticket nuevo.
  const { ticketId } = validBody;
  const rawS3Key = `tenants/${tenant.tenantId}/${ticketId}.txt`;

  // Re-subir el mismo contenido a la misma key en un reintento es
  // inofensivo (sobreescribe con bytes idénticos), así que esto no
  // necesita protección adicional de idempotencia.
  await s3.send(
    new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: rawS3Key,
      Body: validBody.rawText,
      ContentType: "text/plain; charset=utf-8",
    }),
  );

  const record: TicketRecord & Record<string, unknown> = {
    tenantId: tenant.tenantId,
    ticketId,
    port: validBody.port,
    capturedAt: validBody.capturedAt,
    status: "pending",
    rawS3Key,
    ...ticketKey(tenant.tenantId, validBody.capturedAt, ticketId),
    ...ticketStatusGsiKey(tenant.tenantId, "pending", validBody.capturedAt),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TICKETS_TABLE,
        Item: record,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }
    // Ya existe un ticket con este id — es un reintento del agente sobre
    // algo que el servidor ya había registrado. No hay nada más que hacer:
    // el Stream de la tabla ya disparó (o está por disparar) el parseo a
    // partir de la escritura original, así que no hace falta reencolar
    // nada — a diferencia de una cola SQS aparte, acá no hay un paso
    // intermedio que pueda haber fallado por separado.
  }

  return { statusCode: 202, body: JSON.stringify({ ticketId }) };
}
