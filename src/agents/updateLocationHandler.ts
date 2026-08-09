import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { agentKey, AGENTS_TABLE, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";

interface AgentLocation {
  label: string;
  city: string;
  lat: number;
  lng: number;
}

function parseLocation(raw: string | null): AgentLocation | undefined {
  try {
    const body = JSON.parse(raw ?? "{}") as Partial<AgentLocation>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    if (typeof body.label !== "string" || !body.label.trim() || body.label.trim().length > 120) return undefined;
    if (typeof body.city !== "string" || !body.city.trim() || body.city.trim().length > 120) return undefined;
    if (typeof body.lat !== "number" || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90) return undefined;
    if (typeof body.lng !== "number" || !Number.isFinite(body.lng) || body.lng < -180 || body.lng > 180) return undefined;
    return { label: body.label.trim(), city: body.city.trim(), lat: body.lat, lng: body.lng };
  } catch {
    return undefined;
  }
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) return jsonResponse(403, { error: "no autenticado" });

  const agentId = event.pathParameters?.agentId;
  if (!agentId) return jsonResponse(400, { error: "falta agentId en el path" });

  const location = parseLocation(event.body);
  if (!location) return jsonResponse(400, { error: "ubicación inválida" });

  try {
    await ddb.send(new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: agentKey(tenantId, agentId),
      UpdateExpression: "SET #location = :location",
      ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
      ExpressionAttributeNames: { "#location": "location" },
      ExpressionAttributeValues: { ":location": location },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return jsonResponse(404, { error: "agente no encontrado" });
    }
    throw err;
  }

  return jsonResponse(200, { agentId, location });
}
