import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, REPORTS_TABLE, reportKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { reportIdFromEvent } from "./reportIdParam.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const reportId = reportIdFromEvent(event);
  if (!reportId) {
    return jsonResponse(400, { error: "falta reportId en el path" });
  }

  // Idempotente, igual que el borrado de widgets: DeleteItem no falla si no existe.
  await ddb.send(new DeleteCommand({ TableName: REPORTS_TABLE, Key: reportKey(tenantId, reportId) }));
  return jsonResponse(204);
}
