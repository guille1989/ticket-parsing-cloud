import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { AGENTS_TABLE, ddb } from "./dynamo.js";
import { AgentRecord } from "./types.js";

const API_KEY_INDEX = "apiKeyId-index";

/**
 * Resuelve el agente (y por lo tanto el tenant) a partir del id de la API
 * key con la que se autenticó. Mismo principio que
 * `tenant.ts:resolveTenantByApiKeyId` — nunca se confía en un tenantId que
 * venga en el body, acá tampoco se confía en nada que diga el agente sobre
 * quién es más allá de la key que usó para autenticarse.
 */
export async function resolveAgentByApiKeyId(apiKeyId: string): Promise<AgentRecord | undefined> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: AGENTS_TABLE,
      IndexName: API_KEY_INDEX,
      KeyConditionExpression: "apiKeyId = :apiKeyId",
      ExpressionAttributeValues: { ":apiKeyId": apiKeyId },
      Limit: 1,
    }),
  );
  return result.Items?.[0] as AgentRecord | undefined;
}
