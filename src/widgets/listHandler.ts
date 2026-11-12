import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { WIDGETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { queryAllPages } from "../shared/pagination.js";
import type { WidgetRecord } from "../shared/types.js";
import { userViewFor, widgetVisibleTo } from "../shared/userView.js";

function toPublicWidget(item: WidgetRecord) {
  return {
    widgetId: item.widgetId,
    name: item.name,
    visualization: item.visualization,
    metric: item.metric,
    secondaryMetric: item.secondaryMetric,
    groupBy: item.groupBy,
    filters: item.filters,
    createdAt: item.createdAt,
  };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenant = await resolveActiveTenantFromEvent(event);
  if (!tenant) {
    return jsonResponse(403, { error: "no autenticado" });
  }
  const tenantId = tenant.tenantId;
  const userId = resolveUserIdFromEvent(event);
  const ownView = userViewFor(tenant, userId) !== undefined;

  const items = await queryAllPages<WidgetRecord>({
    TableName: WIDGETS_TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "WIDGET#" },
  });

  const widgets = items.filter((w) => widgetVisibleTo(w, userId, ownView)).map(toPublicWidget);
  return jsonResponse(200, { widgets });
}
