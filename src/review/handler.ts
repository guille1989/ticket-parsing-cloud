import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { analyticsRowKey, writeAnalyticsRows } from "../analytics/writeAnalyticsRows.js";
import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ANALYTICS_BUCKET, ddb, ticketStatusGsiKey, ticketKey, TICKETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { TicketRecord } from "../shared/types.js";

const s3 = new S3Client({});

type Action = "confirm" | "discard";

interface ReviewBody {
  action: Action;
  /**
   * El dashboard ya lo tiene (viene en cada ticket de `GET /tickets`) — se
   * pide en el body en vez de resolverlo acá con una lectura extra, porque
   * sin el sort key completo (`TICKET#<capturedAt>#<ticketId>`) no hay
   * forma barata de ubicar el ticket en DynamoDB solo por su id.
   */
  capturedAt: string;
}

function parseBody(raw: string | null): ReviewBody | undefined {
  try {
    const body = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    if (body.action !== "confirm" && body.action !== "discard") return undefined;
    if (typeof body.capturedAt !== "string" || !body.capturedAt) return undefined;
    return { action: body.action, capturedAt: body.capturedAt };
  } catch {
    return undefined;
  }
}

/**
 * Confirma o descarta un ticket en `needs_review` — la única forma en que
 * un ticket sale de ese estado hoy (antes no existía ningún mecanismo, se
 * quedaban ahí para siempre). Lo hace el dueño del negocio desde su
 * dashboard, mirando lo que se extrajo (no la imagen del ticket todavía —
 * eso queda para una iteración futura si hace falta).
 *
 * "confirm" lo promueve a `parsed` y actualiza la fila de analítica en S3
 * (estaba con `status: "needs_review"`, ahora cuenta como confiable).
 * "discard" lo manda a `discarded` y BORRA esa fila — no era una venta
 * real, no debe seguir sumando en ningún reporte.
 */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) return jsonResponse(403, { error: "no autenticado" });

  const ticketId = event.pathParameters?.ticketId;
  if (!ticketId) return jsonResponse(400, { error: "falta ticketId en el path" });

  const body = parseBody(event.body);
  if (!body) {
    return jsonResponse(400, { error: 'body inválido, se esperaba {"action":"confirm"|"discard","capturedAt":"<ISO-8601>"}' });
  }

  const newStatus = body.action === "confirm" ? "parsed" : "discarded";
  const gsiKeys = ticketStatusGsiKey(tenantId, newStatus, body.capturedAt);

  let updated: TicketRecord;
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: ticketKey(tenantId, body.capturedAt, ticketId),
        // Solo se puede confirmar/descartar algo que está en needs_review
        // — ni un ticket ya revisado (doble click), ni uno pending/failed.
        ConditionExpression: "#status = :needsReview",
        UpdateExpression: "SET #status = :newStatus, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":needsReview": "needs_review",
          ":newStatus": newStatus,
          ":gsi1pk": gsiKeys.gsi1pk,
          ":gsi1sk": gsiKeys.gsi1sk,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    updated = result.Attributes as TicketRecord;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return jsonResponse(409, { error: "el ticket no está en needs_review (ya fue revisado, o no existe)" });
    }
    throw err;
  }

  if (body.action === "discard") {
    await s3
      .send(new DeleteObjectCommand({ Bucket: ANALYTICS_BUCKET, Key: analyticsRowKey(tenantId, body.capturedAt, ticketId) }))
      .catch(() => {
        // Best-effort: un ticket needs_review sin items nunca tuvo fila que borrar.
      });
  } else if (updated.items && updated.items.length > 0 && updated.parsedBy) {
    await writeAnalyticsRows(
      ANALYTICS_BUCKET,
      {
        tenantId,
        ticketId,
        capturedAt: body.capturedAt,
        port: updated.port,
        agentId: updated.agentId,
        parsedBy: updated.parsedBy,
        status: "parsed",
      },
      {
        items: updated.items,
        total: updated.total ?? 0,
        tax: updated.tax,
        discount: updated.discount,
        tip: updated.tip,
        timestamp: body.capturedAt,
      },
    );
  }

  return jsonResponse(200, { ticketId, status: newStatus });
}
