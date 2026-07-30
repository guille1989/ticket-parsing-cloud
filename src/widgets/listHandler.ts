import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { ddb, WIDGETS_TABLE } from "../shared/dynamo.js";
import { resolveTenantByApiKeyId } from "../shared/tenant.js";
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

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity?.apiKeyId;
  if (!apiKeyId) {
    return { statusCode: 403, body: JSON.stringify({ error: "falta API key" }) };
  }

  const tenant = await resolveTenantByApiKeyId(apiKeyId);
  if (!tenant) {
    return { statusCode: 403, body: JSON.stringify({ error: "API key no asociada a ningún tenant" }) };
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: WIDGETS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenant.tenantId}`, ":prefix": "WIDGET#" },
    }),
  );

  const widgets = (result.Items as WidgetRecord[] | undefined)?.map(toPublicWidget) ?? [];
  return { statusCode: 200, body: JSON.stringify({ widgets }) };
}
