import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import type { StoredReportItem } from "../assistant/reportStore.js";
import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, REPORTS_TABLE, reportKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const reportId = event.pathParameters?.reportId;
  if (!reportId) {
    return jsonResponse(400, { error: "falta reportId en el path" });
  }

  // La clave sale del tenant autenticado, no del path: no se puede leer el reporte de otro negocio.
  const result = await ddb.send(new GetCommand({ TableName: REPORTS_TABLE, Key: reportKey(tenantId, reportId) }));
  const item = result.Item as StoredReportItem | undefined;
  if (!item || item.ttl <= Math.floor(Date.now() / 1000)) {
    return jsonResponse(404, { error: "reporte no encontrado o vencido" });
  }

  return jsonResponse(200, {
    reportId: item.reportId,
    summary: item.summary,
    report: item.report,
    createdAt: item.createdAt,
    expiresAt: new Date(item.ttl * 1000).toISOString(),
  });
}
