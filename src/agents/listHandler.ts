import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { AGENTS_TABLE, ddb } from "../shared/dynamo.js";
import type { AgentRecord } from "../shared/types.js";

function toPublicAgent(item: AgentRecord) {
  return {
    agentId: item.agentId,
    name: item.name,
    createdAt: item.createdAt,
    // Sin heartbeat implementado todavía (ver PROYECTO.md) esto queda
    // siempre ausente — se deja pasar tal cual en vez de inventar un
    // estado online/offline que todavía no significa nada.
    lastSeenAt: item.lastSeenAt,
  };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return { statusCode: 403, body: JSON.stringify({ error: "no autenticado" }) };
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
    }),
  );

  const agents = (result.Items as AgentRecord[] | undefined)?.map(toPublicAgent) ?? [];
  return { statusCode: 200, body: JSON.stringify({ agents }) };
}
