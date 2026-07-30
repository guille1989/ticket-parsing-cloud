import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { ATHENA_WORKGROUP, ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import { resolveTenantByApiKeyId } from "../shared/tenant.js";
import type { WidgetRecord } from "../shared/types.js";
import { runWidgetQuery } from "./athenaQuery.js";
import { buildWidgetQuery } from "./queryBuilder.js";

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

  const result = await ddb.send(new GetCommand({ TableName: WIDGETS_TABLE, Key: widgetKey(tenant.tenantId, widgetId) }));
  const widget = result.Item as WidgetRecord | undefined;
  if (!widget) {
    return { statusCode: 404, body: JSON.stringify({ error: "widget no encontrado" }) };
  }

  let query;
  try {
    query = buildWidgetQuery(widget);
  } catch (err) {
    // No debería pasar nunca si createHandler validó bien al guardar, pero
    // si un registro corrupto llegó hasta acá, mejor un 500 claro que
    // dejarlo generar SQL con un campo fuera de la lista blanca.
    console.error(`[widgets] el widget ${widgetId} tiene una configuración inválida:`, err);
    return { statusCode: 500, body: JSON.stringify({ error: "el widget tiene una configuración inválida" }) };
  }

  const data = await runWidgetQuery(query.sql, query.params, ATHENA_WORKGROUP);

  return { statusCode: 200, body: JSON.stringify({ widgetId, visualization: widget.visualization, data }) };
}
