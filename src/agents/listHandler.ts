import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent } from "../shared/auth.js";
import { AGENTS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { queryAllPages } from "../shared/pagination.js";
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
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const items = await queryAllPages<AgentRecord>({
    TableName: AGENTS_TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
  });

  const agents = items.map(toPublicAgent);
  return jsonResponse(200, { agents });
}
