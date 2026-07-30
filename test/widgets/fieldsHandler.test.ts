import type { APIGatewayProxyEvent } from "aws-lambda";

const mockResolveTenantByApiKeyId = jest.fn();

jest.mock("../../src/shared/tenant", () => ({
  resolveTenantByApiKeyId: (...args: unknown[]) => mockResolveTenantByApiKeyId(...args),
}));

import { handler } from "../../src/widgets/fieldsHandler";
import { AGGREGATIONS, CATEGORICAL_FIELDS, EVENT_COUNT_FIELD, NUMERIC_FIELDS } from "../../src/widgets/fields";

const validTenant = { tenantId: "t1", businessName: "Negocio", parserId: "example-38col", apiKeyId: "key1", createdAt: "2026-01-01T00:00:00.000Z" };

function eventWith(apiKeyId: string | undefined): APIGatewayProxyEvent {
  return { requestContext: { identity: { apiKeyId } } } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockResolveTenantByApiKeyId.mockReset();
});

test("devuelve la lista blanca completa, incluyendo el pseudo-campo event_count", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);

  const result = await handler(eventWith("key1"));
  const body = JSON.parse(result.body);

  expect(body.numericFields).toEqual([...NUMERIC_FIELDS, EVENT_COUNT_FIELD]);
  expect(body.categoricalFields).toEqual(CATEGORICAL_FIELDS);
  expect(body.aggregations).toEqual(AGGREGATIONS);
});

test("sin API key: 403", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(403);
});
