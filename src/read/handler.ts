import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, TICKETS_TABLE } from "../shared/dynamo.js";
import { TicketRecord, TicketStatus } from "../shared/types.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const VALID_STATUSES: TicketStatus[] = ["pending", "parsed", "needs_review", "failed"];

function parseLimit(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function decodeCursor(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), "utf-8").toString("base64url");
}

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
    discount: item.discount,
    tip: item.tip,
    failReason: item.failReason,
    // Un negocio que audite `needs_review` necesita saber que ese ticket
    // vino del fallback de Bedrock, no del parser determinístico, para no
    // confiar en el monto de la misma forma hasta que se revise a mano.
    parsedBy: item.parsedBy,
  };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return { statusCode: 403, body: JSON.stringify({ error: "no autenticado" }) };
  }

  const params = event.queryStringParameters ?? {};
  const status = params.status;
  if (status && !VALID_STATUSES.includes(status as TicketStatus)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `status inválido, se esperaba uno de: ${VALID_STATUSES.join(", ")}` }),
    };
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
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
          ScanIndexForward: false,
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

  const tickets = (result.Items as TicketRecord[] | undefined)?.map(toPublicTicket) ?? [];

  return {
    statusCode: 200,
    body: JSON.stringify({ tickets, nextCursor: encodeCursor(result.LastEvaluatedKey) }),
  };
}
