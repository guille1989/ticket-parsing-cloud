import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ACTIVATION_CODES_TABLE, ddb } from "../shared/dynamo.js";
import type { ActivationCodeRecord } from "../shared/types.js";

const TENANT_INDEX = "tenantId-index";

function toPublicCode(item: ActivationCodeRecord) {
  return {
    code: item.code,
    status: item.status,
    createdAt: item.createdAt,
    usedAt: item.usedAt,
    agentId: item.agentId,
  };
}

/**
 * Lista los (hasta 5) códigos de activación del tenant, usados o no — así
 * el dashboard puede mostrar "3 de 5 robots activados" y dejar copiar los
 * códigos que todavía no se canjearon. Autenticado con Cognito, como el
 * resto de los endpoints que usa el dashboard — ver `shared/auth.ts`.
 */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return { statusCode: 403, body: JSON.stringify({ error: "no autenticado" }) };
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: ACTIVATION_CODES_TABLE,
      IndexName: TENANT_INDEX,
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": tenantId },
    }),
  );

  const codes = (result.Items as ActivationCodeRecord[] | undefined)?.map(toPublicCode) ?? [];
  return { statusCode: 200, body: JSON.stringify({ codes }) };
}
