import { createHash } from "node:crypto";

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { resolveAgentByApiKeyId } from "../shared/agent.js";
import { ddb, dedupKey, RAW_BUCKET, ticketKey, ticketStatusGsiKey, TICKETS_TABLE } from "../shared/dynamo.js";
import { getTenant, resolveTenantByApiKeyId } from "../shared/tenant.js";
import { TicketRecord } from "../shared/types.js";

type ResolvedTenant = { tenantId: string; blocked: boolean; agentId?: string };

/**
 * Un agente activado por código (ver `agents/activateHandler.ts`) sube con
 * su propia api-key, no la del tenant — se prueba esa resolución primero.
 * La api-key compartida del tenant (onboarding original, `onboard-tenant.ts`)
 * sigue funcionando como fallback para no romper instalaciones existentes.
 *
 * Un tenant bloqueado (`scripts/set-tenant-status.ts`) no puede seguir
 * subiendo tickets aunque su agente ya esté activado y su api-key siga
 * siendo válida — bloquear solo el login del dashboard no alcanza. Cuando
 * resuelve por api-key de AGENTE hace falta una lectura extra a Tenants
 * (el registro del agente no trae el status), cuando resuelve por la
 * api-key compartida del tenant ya viene en el mismo registro.
 */
async function resolveTenantId(apiKeyId: string): Promise<ResolvedTenant | undefined> {
  const agent = await resolveAgentByApiKeyId(apiKeyId);
  if (agent) {
    const tenant = await getTenant(agent.tenantId);
    return { tenantId: agent.tenantId, blocked: tenant?.status === "blocked", agentId: agent.agentId };
  }
  const tenant = await resolveTenantByApiKeyId(apiKeyId);
  if (!tenant) return undefined;
  return { tenantId: tenant.tenantId, blocked: tenant.status === "blocked" };
}

const s3 = new S3Client({});

/**
 * `"text"`: captura serie/TCP, `rawContent` es el texto crudo.
 * `"escpos"`: captura de spool, `rawContent` son los bytes ESC/POS ya
 * decodificados (pueden ser texto o una imagen raster — lo decide el parser).
 */
type RawTicketBody =
  | { ticketId: string; port: string; capturedAt: string; rawKind: "text"; rawContent: string }
  | { ticketId: string; port: string; capturedAt: string; rawKind: "escpos"; rawContent: Buffer };

// `ticketId` termina siendo parte de la key de S3 (`tenants/<id>/<ticketId>.<ext>`)
// y del sort key de DynamoDB — exigir forma de UUID (lo que ya genera el
// agente) evita cualquier chance de path traversal o de romper esas claves
// con caracteres raros.
const TICKET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `port` se usa como key de un diccionario (`Tenants.portParsers`) y queda
// guardado tal cual — NUNCA en una URL ni en la key de S3. Puede ser un
// identificador tipo COM3 / LPT1, un id lógico de periférico TCP
// (`datafono-caja1`), o —captura de spool— el nombre de la impresora, que
// suele tener espacios y paréntesis ("EPSON TM-T20II Receipt", "HP LaserJet
// (copia 1)"). Se permite todo lo imprimible ASCII salvo comillas y barra
// invertida.
const PORT_PATTERN = /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/;
const MAX_PORT_LENGTH = 100;
// El mismo formato que produce `new Date().toISOString()` — es lo único
// que manda el agente. `capturedAt` compone el sort key de DynamoDB
// (`TICKET#<capturedAt>#<ticketId>`), así que una fecha inválida rompe el
// orden cronológico de todo el tenant, no solo este ticket.
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Ninguna impresora térmica genera un ticket de TEXTO ni remotamente cerca
// de esto — cota generosa para no bloquear un caso real, pero sí evitar que
// un body gigante llegue a escribirse en S3.
const MAX_RAW_TEXT_BYTES = 64 * 1024;
// El `.SPL` de un ticket con logo raster ronda los 200 KB; 6 MB cubre con
// margen cualquier ticket real y queda por debajo del límite de payload de
// API Gateway (10 MB). Va alineado con `SPOOL_MAX_JOB_BYTES` del agente.
const MAX_RAW_ESCPOS_BYTES = 6 * 1024 * 1024;
const MAX_RAW_BASE64_CHARS = Math.ceil(MAX_RAW_ESCPOS_BYTES / 3) * 4 + 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Ventana para descartar contenido idéntico repetido (ver `dedupKey`).
 * Detectado en el piloto de Empanadas: Loggro reenvía el ticket completo
 * como un job de impresión nuevo (mismo tamaño en bytes, mismos bytes) unos
 * segundos después del original, aunque la impresora solo sacó un papel —
 * sin esto, esa venta se registraba y facturaba dos veces. El ticket real
 * (imagen del recibo) lleva número de factura y hora con segundos, así que
 * dos ventas distintas no producen jamás los mismos bytes — 5 minutos da
 * margen de sobra sin riesgo real de descartar una venta legítima.
 */
const DEDUP_WINDOW_SECONDS = 5 * 60;

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
      error: `port inválido (máx ${MAX_PORT_LENGTH} caracteres imprimibles; sin comillas ni barra invertida)`,
    };
  }
  if (typeof b.capturedAt !== "string" || !ISO_8601_PATTERN.test(b.capturedAt) || Number.isNaN(Date.parse(b.capturedAt))) {
    return { ok: false, error: "capturedAt inválido, se esperaba ISO-8601 (ej. 2026-07-27T12:00:00.000Z)" };
  }

  const hasText = b.rawText !== undefined;
  const hasBase64 = b.rawBase64 !== undefined;
  if (hasText === hasBase64) {
    return { ok: false, error: "se esperaba exactamente uno de rawText o rawBase64" };
  }

  const common = { ticketId: b.ticketId, port: b.port, capturedAt: b.capturedAt };

  if (hasBase64) {
    if (b.rawEncoding !== "escpos") {
      return { ok: false, error: 'rawEncoding inválido: con rawBase64 se espera "escpos"' };
    }
    if (typeof b.rawBase64 !== "string" || b.rawBase64.length === 0) {
      return { ok: false, error: "rawBase64 inválido, se esperaba base64 no vacío" };
    }
    if (b.rawBase64.length > MAX_RAW_BASE64_CHARS || b.rawBase64.length % 4 !== 0 || !BASE64_PATTERN.test(b.rawBase64)) {
      return { ok: false, error: "rawBase64 inválido o demasiado grande" };
    }
    const rawContent = Buffer.from(b.rawBase64, "base64");
    if (rawContent.length === 0) {
      return { ok: false, error: "rawBase64 no decodifica a ningún byte" };
    }
    if (rawContent.length > MAX_RAW_ESCPOS_BYTES) {
      return { ok: false, error: `contenido demasiado grande (máx ${MAX_RAW_ESCPOS_BYTES} bytes, recibidos ${rawContent.length})` };
    }
    return { ok: true, value: { ...common, rawKind: "escpos", rawContent } };
  }

  if (typeof b.rawText !== "string" || b.rawText.length === 0) {
    return { ok: false, error: "rawText inválido, se esperaba texto no vacío" };
  }
  const rawTextBytes = Buffer.byteLength(b.rawText, "utf-8");
  if (rawTextBytes > MAX_RAW_TEXT_BYTES) {
    return { ok: false, error: `rawText demasiado grande (máx ${MAX_RAW_TEXT_BYTES} bytes, recibidos ${rawTextBytes})` };
  }
  return { ok: true, value: { ...common, rawKind: "text", rawContent: b.rawText } };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity?.apiKeyId;
  if (!apiKeyId) {
    return { statusCode: 403, body: JSON.stringify({ error: "falta API key" }) };
  }

  const resolved = await resolveTenantId(apiKeyId);
  if (!resolved) {
    return { statusCode: 403, body: JSON.stringify({ error: "API key no asociada a ningún tenant" }) };
  }
  if (resolved.blocked) {
    return { statusCode: 403, body: JSON.stringify({ error: "tenant bloqueado" }) };
  }
  const { tenantId, agentId } = resolved;

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
  const { ticketId, rawKind } = validBody;
  const rawS3Key =
    rawKind === "escpos" ? `tenants/${tenantId}/${ticketId}.escpos` : `tenants/${tenantId}/${ticketId}.txt`;

  // Hash sobre puerto + contenido crudo: dos tickets de un mismo puerto con
  // bytes idénticos dentro de la ventana son, en la práctica, el mismo
  // envío duplicado (ver comentario de DEDUP_WINDOW_SECONDS), no dos ventas
  // que coincidieron. Escritura condicional = "primero en llegar gana";
  // quien pierde la carrera se descarta sin tocar S3 ni la tabla de tickets.
  const contentHash = createHash("sha256")
    .update(validBody.port, "utf-8")
    .update(rawKind === "escpos" ? (validBody.rawContent as Buffer) : Buffer.from(validBody.rawContent as string, "utf-8"))
    .digest("hex");

  try {
    await ddb.send(
      new PutCommand({
        TableName: TICKETS_TABLE,
        Item: {
          ...dedupKey(tenantId, contentHash),
          ticketId,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + DEDUP_WINDOW_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }
    console.log(
      `[ingest] ticket duplicado descartado (mismo contenido en los últimos ${DEDUP_WINDOW_SECONDS}s): ` +
        `tenant=${tenantId} port=${validBody.port} ticketId=${ticketId}`,
    );
    return { statusCode: 202, body: JSON.stringify({ ticketId, duplicate: true }) };
  }

  // Re-subir el mismo contenido a la misma key en un reintento es
  // inofensivo (sobreescribe con bytes idénticos), así que esto no
  // necesita protección adicional de idempotencia.
  await s3.send(
    new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: rawS3Key,
      Body: validBody.rawContent,
      ContentType: rawKind === "escpos" ? "application/octet-stream" : "text/plain; charset=utf-8",
    }),
  );

  const record: TicketRecord & Record<string, unknown> = {
    tenantId,
    ticketId,
    port: validBody.port,
    agentId,
    capturedAt: validBody.capturedAt,
    status: "pending",
    rawS3Key,
    rawKind,
    ...ticketKey(tenantId, validBody.capturedAt, ticketId),
    ...ticketStatusGsiKey(tenantId, "pending", validBody.capturedAt),
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
