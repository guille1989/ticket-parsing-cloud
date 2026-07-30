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

import { handler } from "../../src/widgets/deleteHandler";

const validTenant = { tenantId: "t1", businessName: "Negocio", parserId: "example-38col", apiKeyId: "key1", createdAt: "2026-01-01T00:00:00.000Z" };

function eventWith(widgetId: string | undefined): APIGatewayProxyEvent {
  return {
    requestContext: { identity: { apiKeyId: "key1" } },
    pathParameters: widgetId ? { widgetId } : null,
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockResolveTenantByApiKeyId.mockReset();
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockDdbSend.mockResolvedValue({});
});

test("borra el widget usando la clave del tenant autenticado, no uno del path", async () => {
  const result = await handler(eventWith("w1"));

  expect(result.statusCode).toBe(204);
  const del = mockDdbSend.mock.calls[0][0].input;
  expect(del.Key).toEqual({ pk: "TENANT#t1", sk: "WIDGET#w1" });
});

test("sin widgetId en el path: 400", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});
