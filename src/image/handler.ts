import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { extractRasterPng, looksRasterDominant, readEscpos } from "../parsing/escpos.js";
import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, RAW_BUCKET, ticketKey, TICKETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { TicketRecord } from "../shared/types.js";

const s3 = new S3Client({});

/**
 * Reconstruye a PNG el ticket-imagen que el dueño del negocio está por
 * confirmar/descartar en `needs_review` — para que pueda comparar contra el
 * papel real en vez de confiar a ciegas en lo que extrajo Bedrock. Mismo
 * criterio que `parser/handler.ts` para decidir si hay imagen: `rawKind`
 * ESC/POS y el contenido es mayormente raster (un ticket de texto plano no
 * tiene nada que reconstruir).
 *
 * Va como base64 en el JSON de respuesta (no un `Content-Type: image/png`
 * binario) para no tener que habilitar `binaryMediaTypes` en el API Gateway
 * — un ticket es chico (decenas de KB), el ~33% de más por base64 no importa
 * acá y el resto de la API ya sigue este mismo patrón de `jsonResponse`.
 */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) return jsonResponse(403, { error: "no autenticado" });

  const ticketId = event.pathParameters?.ticketId;
  if (!ticketId) return jsonResponse(400, { error: "falta ticketId en el path" });

  const capturedAt = event.queryStringParameters?.capturedAt;
  if (!capturedAt) return jsonResponse(400, { error: "falta capturedAt en el query string" });

  const { Item } = await ddb.send(new GetCommand({ TableName: TICKETS_TABLE, Key: ticketKey(tenantId, capturedAt, ticketId) }));
  const item = Item as TicketRecord | undefined;
  if (!item) return jsonResponse(404, { error: "ticket no encontrado" });

  if (item.rawKind !== "escpos") {
    return jsonResponse(404, { error: "este ticket no tiene imagen (se capturó como texto)" });
  }

  const raw = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: item.rawS3Key }));
  const bytes = Buffer.from((await raw.Body?.transformToByteArray()) ?? new Uint8Array());
  const content = readEscpos(bytes);
  if (!looksRasterDominant(content)) {
    return jsonResponse(404, { error: "este ticket no tiene imagen (el ESC/POS es texto, no raster)" });
  }

  const image = extractRasterPng(bytes);
  if (!image) return jsonResponse(404, { error: "no se pudo reconstruir la imagen" });

  return jsonResponse(200, {
    ticketId,
    width: image.width,
    height: image.height,
    png: `data:image/png;base64,${image.png.toString("base64")}`,
  });
}
