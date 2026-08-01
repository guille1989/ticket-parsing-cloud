import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return { statusCode: 403, body: JSON.stringify({ error: "no autenticado" }) };
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
      Key: widgetKey(tenantId, widgetId),
    }),
  );

  return { statusCode: 204, body: "" };
}
