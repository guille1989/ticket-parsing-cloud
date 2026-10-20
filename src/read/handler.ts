import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, TICKETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { decodeCursor, encodeCursor, parseLimit } from "../shared/pagination.js";
import { TicketRecord, TicketStatus } from "../shared/types.js";

const VALID_STATUSES: TicketStatus[] = ["pending", "parsed", "needs_review", "failed", "discarded"];

/** Solo lo que le interesa a un negocio ver — sin claves internas de DynamoDB. */
function toPublicTicket(item: TicketRecord) {
  return {
    ticketId: item.ticketId,
    port: item.port,
    capturedAt: item.capturedAt,
    status: item.status,
    parsedAt: item.parsedAt,
    items: item.items,
    total: item.total,
    tax: item.tax,
    discount: item.discount,
    tip: item.tip,
    failReason: item.failReason,
    // Un negocio que audite `needs_review` necesita saber que ese ticket
    // vino del fallback de Bedrock, no del parser determinístico, para no
    // confiar en el monto de la misma forma hasta que se revise a mano.
    parsedBy: item.parsedBy,
    // Quién revisó el ticket y qué decidió (ver `review/handler.ts`).
    reviewedBy: item.reviewedBy,
    reviewedAt: item.reviewedAt,
    reviewDecision: item.reviewDecision,
  };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const params = event.queryStringParameters ?? {};
  const status = params.status;
  if (status && !VALID_STATUSES.includes(status as TicketStatus)) {
    return jsonResponse(400, { error: `status inválido, se esperaba uno de: ${VALID_STATUSES.join(", ")}` });
  }

  const limit = parseLimit(params.limit);
  const exclusiveStartKey = decodeCursor(params.cursor);

  const result = status
    ? await ddb.send(
        new QueryCommand({
          TableName: TICKETS_TABLE,
          IndexName: "status-index",
          KeyConditionExpression: "gsi1pk = :gsi1pk",
          ExpressionAttributeValues: { ":gsi1pk": `TENANT#${tenantId}#STATUS#${status}` },
          ScanIndexForward: false,
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      )
    : await ddb.send(
        new QueryCommand({
          TableName: TICKETS_TABLE,
          // El prefijo va en la condición de clave (no en un filtro): el filtro
          // se aplica después de `Limit` y los marcadores `DEDUP#` (mismo `pk`)
          // gastarían cupo de la página y saldrían como tickets vacíos.
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "TICKET#" },
          ScanIndexForward: false,
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

  const tickets = (result.Items as TicketRecord[] | undefined)?.map(toPublicTicket) ?? [];

  return jsonResponse(200, { tickets, nextCursor: encodeCursor(result.LastEvaluatedKey) });
}
