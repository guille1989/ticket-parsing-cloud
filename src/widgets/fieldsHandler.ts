import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { AGGREGATIONS, CATEGORICAL_FIELDS, EVENT_COUNT_FIELD, NUMERIC_FIELDS } from "./fields.js";

/**
 * Le dice al armador de widgets del frontend qué campos/agregaciones puede
 * ofrecer, para que no tenga la lista blanca hardcodeada por su cuenta (que
 * además tendría que mantenerse a mano en sincro con `fields.ts`).
 */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return { statusCode: 403, body: JSON.stringify({ error: "no autenticado" }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      numericFields: [...NUMERIC_FIELDS, EVENT_COUNT_FIELD],
      categoricalFields: CATEGORICAL_FIELDS,
      aggregations: AGGREGATIONS,
    }),
  };
}
