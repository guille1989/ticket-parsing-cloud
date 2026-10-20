import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import type { StoredReportItem } from "../assistant/reportStore.js";
import { resolveActiveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, REPORTS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { decodeCursor, encodeCursor, parseLimit } from "../shared/pagination.js";

/** Lista los reportes del negocio (solo metadata, sin el contenido), del más nuevo al más viejo. */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const params = event.queryStringParameters ?? {};
  const result = await ddb.send(
    new QueryCommand({
      TableName: REPORTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "REPORT#" },
      ProjectionExpression: "reportId, title, createdAt, #ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ScanIndexForward: false,
      Limit: parseLimit(params.limit),
      ExclusiveStartKey: decodeCursor(params.cursor),
    }),
  );

  // DynamoDB borra los vencidos con demora (hasta ~48 h): se filtran acá.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const reports = ((result.Items ?? []) as Pick<StoredReportItem, "reportId" | "title" | "createdAt" | "ttl">[])
    .filter((item) => item.ttl > nowSeconds)
    .map((item) => ({
      reportId: item.reportId,
      title: item.title,
      createdAt: item.createdAt,
      expiresAt: new Date(item.ttl * 1000).toISOString(),
    }));
  // Los vencidos filtrados pueden dejar la página con menos filas que `limit`:
  // `nextCursor` sigue indicando si hay más, no la cantidad devuelta.
  return jsonResponse(200, { reports, nextCursor: encodeCursor(result.LastEvaluatedKey) });
}
