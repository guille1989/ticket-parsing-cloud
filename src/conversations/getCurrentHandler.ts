import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { CONVERSATIONS_TABLE, conversationSkPrefix, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { StoredConversationItem } from "./conversationStore.js";

/** Devuelve la conversación más reciente de la persona logueada (`conversation: null` si no tiene o venció). */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  const userId = resolveUserIdFromEvent(event);
  if (!tenantId || !userId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  // La clave sale del tenant y la identidad autenticados, no de la petición: nadie lee conversaciones ajenas.
  const result = await ddb.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": conversationSkPrefix(userId) },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  // Si la más nueva ya venció (DynamoDB borra con demora), las anteriores también.
  const item = result.Items?.[0] as StoredConversationItem | undefined;
  if (!item || item.ttl <= Math.floor(Date.now() / 1000)) {
    return jsonResponse(200, { conversation: null });
  }

  return jsonResponse(200, {
    conversation: {
      conversationId: item.conversationId,
      messages: item.messages,
      history: item.history,
      updatedAt: item.updatedAt,
      expiresAt: new Date(item.ttl * 1000).toISOString(),
    },
  });
}
