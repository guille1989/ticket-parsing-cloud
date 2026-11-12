import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { userViewFor } from "../shared/userView.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenant = await resolveActiveTenantFromEvent(event);
  if (!tenant) {
    return jsonResponse(403, { error: "no autenticado" });
  }
  const tenantId = tenant.tenantId;
  const userId = resolveUserIdFromEvent(event);
  const ownView = userViewFor(tenant, userId) !== undefined;

  const widgetId = event.pathParameters?.widgetId;
  if (!widgetId) {
    return jsonResponse(400, { error: "falta widgetId en el path" });
  }

  // DeleteCommand no falla si la key no existe — idempotente por diseño,
  // no hace falta un GetItem previo solo para confirmar que existía.
  // Cada vista solo borra lo suyo: la propia, sus widgets; el resto del negocio, los compartidos.
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: WIDGETS_TABLE,
        Key: widgetKey(tenantId, widgetId),
        ...(ownView
          ? { ConditionExpression: "userId = :userId", ExpressionAttributeValues: { ":userId": userId } }
          : { ConditionExpression: "attribute_not_exists(userId)" }),
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      // Inexistente o ajeno: igual de idempotente que antes para lo inexistente, y sin borrar lo ajeno.
      return jsonResponse(204);
    }
    throw err;
  }

  return jsonResponse(204);
}
