import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockResolveTenantByApiKeyId = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, WIDGETS_TABLE: "TestWidgets" };
});

jest.mock("../../src/shared/tenant", () => ({
  resolveTenantByApiKeyId: (...args: unknown[]) => mockResolveTenantByApiKeyId(...args),
}));

import { handler } from "../../src/widgets/listHandler";

const validTenant = { tenantId: "t1", businessName: "Negocio", parserId: "example-38col", apiKeyId: "key1", createdAt: "2026-01-01T00:00:00.000Z" };

function eventWith(apiKeyId: string | undefined): APIGatewayProxyEvent {
  return { requestContext: { identity: { apiKeyId } } } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockResolveTenantByApiKeyId.mockReset();
});

test("lista los widgets del tenant autenticado, consultando por pk+prefijo WIDGET#", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockDdbSend.mockResolvedValue({
    Items: [
      {
        pk: "TENANT#t1",
        sk: "WIDGET#w1",
        tenantId: "t1",
        widgetId: "w1",
        name: "Total vendido",
        visualization: "kpi",
        metric: { field: "total", aggregation: "sum" },
        createdAt: "2026-07-29T20:00:00.000Z",
      },
    ],
  });

  const result = await handler(eventWith("key1"));

  const query = mockDdbSend.mock.calls[0][0].input;
  expect(query.ExpressionAttributeValues[":pk"]).toBe("TENANT#t1");
  expect(query.ExpressionAttributeValues[":prefix"]).toBe("WIDGET#");

  const body = JSON.parse(result.body);
  expect(body.widgets).toHaveLength(1);
  expect(body.widgets[0].widgetId).toBe("w1");
  expect(body.widgets[0].pk).toBeUndefined();
});

test("sin API key: 403", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});
