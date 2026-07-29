import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { ddb, TENANTS_TABLE, tenantKey } from "./dynamo.js";
import { TenantRecord } from "./types.js";

const API_KEY_INDEX = "apiKeyId-index";

/**
 * Resuelve el tenant a partir del id de la API key que usó para autenticarse
 * (API Gateway lo pasa en el contexto del request). Nunca hay que confiar en
 * un tenantId que venga en el body: un agente mal configurado (o malicioso)
 * podría mandar el id de otro negocio y escribir en sus datos.
 */
export async function resolveTenantByApiKeyId(apiKeyId: string): Promise<TenantRecord | undefined> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TENANTS_TABLE,
      IndexName: API_KEY_INDEX,
      KeyConditionExpression: "apiKeyId = :apiKeyId",
      ExpressionAttributeValues: { ":apiKeyId": apiKeyId },
      Limit: 1,
    }),
  );
  return result.Items?.[0] as TenantRecord | undefined;
}

export async function getTenant(tenantId: string): Promise<TenantRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: TENANTS_TABLE, Key: tenantKey(tenantId) }),
  );
  return result.Item as TenantRecord | undefined;
}
