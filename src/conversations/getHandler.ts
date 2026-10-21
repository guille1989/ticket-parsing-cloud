import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { CONVERSATIONS_TABLE, conversationKey, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { conversationIdFromEvent } from "./conversationIdParam.js";
import { isValidConversationId, type StoredConversationItem } from "./conversationStore.js";

/** Devuelve una conversación completa de la persona logueada. */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  const userId = resolveUserIdFromEvent(event);
  if (!tenantId || !userId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const conversationId = conversationIdFromEvent(event);
  if (!isValidConversationId(conversationId)) {
    return jsonResponse(400, { error: "conversationId inválido" });
  }

  // La clave sale del tenant y la identidad autenticados: pedir el id de otra persona da 404.
  const result = await ddb.send(new GetCommand({ TableName: CONVERSATIONS_TABLE, Key: conversationKey(tenantId, userId, conversationId) }));
  const item = result.Item as StoredConversationItem | undefined;
  if (!item || item.ttl <= Math.floor(Date.now() / 1000)) {
    return jsonResponse(404, { error: "conversación no encontrada o vencida" });
  }

  return jsonResponse(200, {
    conversationId: item.conversationId,
    title: item.title,
    messages: item.messages,
    history: item.history,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: new Date(item.ttl * 1000).toISOString(),
  });
}
