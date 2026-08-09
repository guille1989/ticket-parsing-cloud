import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ATHENA_WORKGROUP, ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { WidgetRecord } from "../shared/types.js";
import { runWidgetQuery } from "./athenaQuery.js";
import { buildWidgetQuery } from "./queryBuilder.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const widgetId = event.pathParameters?.widgetId;
  if (!widgetId) {
    return jsonResponse(400, { error: "falta widgetId en el path" });
  }

  const result = await ddb.send(new GetCommand({ TableName: WIDGETS_TABLE, Key: widgetKey(tenantId, widgetId) }));
  const widget = result.Item as WidgetRecord | undefined;
  if (!widget) {
    return jsonResponse(404, { error: "widget no encontrado" });
  }

  let query;
  try {
    query = buildWidgetQuery(widget);
  } catch (err) {
    // No debería pasar nunca si createHandler validó bien al guardar, pero
    // si un registro corrupto llegó hasta acá, mejor un 500 claro que
    // dejarlo generar SQL con un campo fuera de la lista blanca.
    console.error(`[widgets] el widget ${widgetId} tiene una configuración inválida:`, err);
    return jsonResponse(500, { error: "el widget tiene una configuración inválida" });
  }

  const data = await runWidgetQuery(query.sql, query.params, ATHENA_WORKGROUP);

  return jsonResponse(200, { widgetId, visualization: widget.visualization, data });
}
