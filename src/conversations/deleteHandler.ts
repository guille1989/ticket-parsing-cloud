import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { CONVERSATIONS_TABLE, conversationKey, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { conversationIdFromEvent } from "./conversationIdParam.js";
import { isValidConversationId } from "./conversationStore.js";

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

  // Idempotente, igual que el borrado de reportes y widgets: DeleteItem no falla si no existe.
  await ddb.send(new DeleteCommand({ TableName: CONVERSATIONS_TABLE, Key: conversationKey(tenantId, userId, conversationId) }));
  return jsonResponse(204);
}
