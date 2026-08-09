import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { AGENTS_TABLE, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { AgentRecord } from "../shared/types.js";

function toPublicAgent(item: AgentRecord) {
  return {
    agentId: item.agentId,
    name: item.name,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    version: item.version,
    location: item.location,
  };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
    }),
  );

  const agents = (result.Items as AgentRecord[] | undefined)?.map(toPublicAgent) ?? [];
  return jsonResponse(200, { agents });
}
