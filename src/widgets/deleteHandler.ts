import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import { resolveTenantByApiKeyId } from "../shared/tenant.js";

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity?.apiKeyId;
  if (!apiKeyId) {
    return { statusCode: 403, body: JSON.stringify({ error: "falta API key" }) };
  }

  const tenant = await resolveTenantByApiKeyId(apiKeyId);
  if (!tenant) {
    return { statusCode: 403, body: JSON.stringify({ error: "API key no asociada a ningún tenant" }) };
  }

  const widgetId = event.pathParameters?.widgetId;
  if (!widgetId) {
    return { statusCode: 400, body: JSON.stringify({ error: "falta widgetId en el path" }) };
  }

  // DeleteCommand no falla si la key no existe — idempotente por diseño,
  // no hace falta un GetItem previo solo para confirmar que existía.
  await ddb.send(
    new DeleteCommand({
      TableName: WIDGETS_TABLE,
      Key: widgetKey(tenant.tenantId, widgetId),
    }),
  );

  return { statusCode: 204, body: "" };
}
