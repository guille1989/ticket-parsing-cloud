import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { CONVERSATIONS_TABLE, conversationSkPrefix, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { decodeCursor, encodeCursor } from "../shared/pagination.js";
import type { StoredConversationItem } from "./conversationStore.js";

// Páginas chicas: DynamoDB cobra por el tamaño de los items leídos (la proyección no lo reduce) y
// cada conversación guarda su hilo completo; el historial se recorre de a poco con "cargar más".
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function parsePageSize(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : PAGE_SIZE;
  if (!Number.isInteger(parsed) || parsed < 1) return PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/** Lista las conversaciones de la persona logueada (solo metadata), de la más nueva a la más vieja por creación. */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  const userId = resolveUserIdFromEvent(event);
  if (!tenantId || !userId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const params = event.queryStringParameters ?? {};
  // La clave sale del tenant y la identidad autenticados, no de la petición: nadie lista conversaciones ajenas.
  const result = await ddb.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": conversationSkPrefix(userId) },
      ProjectionExpression: "conversationId, title, createdAt, updatedAt, #ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ScanIndexForward: false,
      Limit: parsePageSize(params.limit),
      ExclusiveStartKey: decodeCursor(params.cursor),
    }),
  );

  // DynamoDB borra los vencidos con demora (hasta ~48 h): se filtran acá.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const conversations = ((result.Items ?? []) as Pick<StoredConversationItem, "conversationId" | "title" | "createdAt" | "updatedAt" | "ttl">[])
    .filter((item) => item.ttl > nowSeconds)
    .map((item) => ({
      conversationId: item.conversationId,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      expiresAt: new Date(item.ttl * 1000).toISOString(),
    }));
  // Los vencidos filtrados pueden dejar la página con menos filas que `limit`:
  // `nextCursor` sigue indicando si hay más, no la cantidad devuelta.
  return jsonResponse(200, { conversations, nextCursor: encodeCursor(result.LastEvaluatedKey) });
}
