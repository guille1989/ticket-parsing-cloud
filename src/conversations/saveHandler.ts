import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { CONVERSATIONS_TABLE, conversationKey, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import {
  CONVERSATION_RETENTION_DAYS,
  isValidConversationId,
  MAX_BODY_BYTES,
  validateConversationBody,
} from "./conversationStore.js";

/**
 * El id lleva `:` (ISO) y llegan codificados (`%3A`), igual que el reportId: API Gateway REST
 * entrega los path parameters sin decodificar.
 */
function conversationIdFromEvent(event: APIGatewayProxyWithCognitoAuthorizerEvent): string | undefined {
  const raw = event.pathParameters?.conversationId;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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
        "SET conversationId = :id, messages = :messages, history = :history, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":id": conversationId,
        ":messages": validation.messages,
        ":history": validation.history,
        ":now": nowIso,
        ":ttl": ttl,
      },
    }),
  );
  return jsonResponse(204);
}
