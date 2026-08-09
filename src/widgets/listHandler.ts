import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, WIDGETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { WidgetRecord } from "../shared/types.js";

function toPublicWidget(item: WidgetRecord) {
  return {
    widgetId: item.widgetId,
    name: item.name,
    visualization: item.visualization,
    metric: item.metric,
    groupBy: item.groupBy,
    filters: item.filters,
    createdAt: item.createdAt,
  };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: WIDGETS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "WIDGET#" },
    }),
  );

  const widgets = (result.Items as WidgetRecord[] | undefined)?.map(toPublicWidget) ?? [];
  return jsonResponse(200, { widgets });
}
