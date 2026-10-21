import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { CONVERSATIONS_TABLE, conversationKey, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { conversationIdFromEvent } from "./conversationIdParam.js";
import {
  CONVERSATION_RETENTION_DAYS,
  deriveTitle,
  isValidConversationId,
  MAX_BODY_BYTES,
  validateConversationBody,
} from "./conversationStore.js";

/** Crea o reemplaza la conversación (idempotente: el cliente manda el hilo completo cada vez). */
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

  if (event.body && Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: "la conversación es demasiado grande" });
  }
  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }
  const validation = validateConversationBody(body);
  if (!validation.ok) {
    return jsonResponse(400, { error: validation.error });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const ttl = Math.floor(now.getTime() / 1000) + CONVERSATION_RETENTION_DAYS * 24 * 60 * 60;
  await ddb.send(
    new UpdateCommand({
      TableName: CONVERSATIONS_TABLE,
      Key: conversationKey(tenantId, userId, conversationId),
      UpdateExpression:
        "SET conversationId = :id, title = if_not_exists(title, :title), messages = :messages, history = :history, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":id": conversationId,
        // Se fija con el primer guardado: aunque el cliente recorte mensajes viejos, el título no cambia.
        ":title": deriveTitle(validation.messages),
        ":messages": validation.messages,
        ":history": validation.history,
        ":now": nowIso,
        ":ttl": ttl,
      },
    }),
  );
  return jsonResponse(204);
}
