import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { resolveTenantByApiKeyId } from "../shared/tenant.js";
import { AGGREGATIONS, CATEGORICAL_FIELDS, EVENT_COUNT_FIELD, NUMERIC_FIELDS } from "./fields.js";

/**
 * Le dice al armador de widgets del frontend qué campos/agregaciones puede
 * ofrecer, para que no tenga la lista blanca hardcodeada por su cuenta (que
 * además tendría que mantenerse a mano en sincro con `fields.ts`).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity?.apiKeyId;
  if (!apiKeyId) {
    return { statusCode: 403, body: JSON.stringify({ error: "falta API key" }) };
  }

  const tenant = await resolveTenantByApiKeyId(apiKeyId);
  if (!tenant) {
    return { statusCode: 403, body: JSON.stringify({ error: "API key no asociada a ningún tenant" }) };
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
