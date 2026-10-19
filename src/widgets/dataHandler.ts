import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ATHENA_WORKGROUP, ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { WidgetRecord } from "../shared/types.js";
import { runWidgetQuery } from "./athenaQuery.js";
import { isValidTimeZone } from "./fields.js";
import { buildWidgetQuery } from "./queryBuilder.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rango opcional (`?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`) que el dashboard manda
 * cuando el usuario filtra una gráfica por fechas. Se suma a los filtros que el
 * widget ya trae guardados; sin parámetros el comportamiento es el de siempre.
 */
function parseDateRange(event: APIGatewayProxyWithCognitoAuthorizerEvent): { dateFrom?: string; dateTo?: string } | { error: string } {
  const range: { dateFrom?: string; dateTo?: string } = {};
  for (const key of ["dateFrom", "dateTo"] as const) {
    const value = event.queryStringParameters?.[key];
    if (value === undefined) continue;
    if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) return { error: `${key} inválida, se esperaba YYYY-MM-DD` };
    range[key] = value;
  }
  if (range.dateFrom && range.dateTo && range.dateFrom > range.dateTo) return { error: "dateFrom no puede ser posterior a dateTo" };
  return range;
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const widgetId = event.pathParameters?.widgetId;
  if (!widgetId) {
    return jsonResponse(400, { error: "falta widgetId en el path" });
  }

  const range = parseDateRange(event);
  if ("error" in range) {
    return jsonResponse(400, { error: range.error });
  }

  const result = await ddb.send(new GetCommand({ TableName: WIDGETS_TABLE, Key: widgetKey(tenantId, widgetId) }));
  const widget = result.Item as WidgetRecord | undefined;
  if (!widget) {
    return jsonResponse(404, { error: "widget no encontrado" });
  }

  let query;
  try {
    // `?tz=America/Bogota` (zona del navegador): agrupa y filtra por día/hora local. Inválida o ausente → UTC.
    const tzParam = event.queryStringParameters?.tz;
    const timeZone = tzParam && isValidTimeZone(tzParam) ? tzParam : undefined;
    query = buildWidgetQuery({ ...widget, filters: { ...widget.filters, ...range } }, undefined, timeZone);
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
