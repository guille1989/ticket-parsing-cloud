import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { handler } from "../../src/widgets/fieldsHandler";
import { AGGREGATIONS, CATEGORICAL_FIELDS, EVENT_COUNT_FIELD, NUMERIC_FIELDS } from "../../src/widgets/fields";

function eventWith(tenantId: string | undefined): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

test("devuelve la lista blanca completa, incluyendo el pseudo-campo event_count", async () => {
  const result = await handler(eventWith("t1"));
  const body = JSON.parse(result.body);

  expect(body.numericFields).toEqual([...NUMERIC_FIELDS, EVENT_COUNT_FIELD]);
  expect(body.categoricalFields).toEqual(CATEGORICAL_FIELDS);
  expect(body.aggregations).toEqual(AGGREGATIONS);
});

test("sin sesión de Cognito (sin claim de tenantId): 403", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(403);
});
