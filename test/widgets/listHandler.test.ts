import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, WIDGETS_TABLE: "TestWidgets" };
});

import { handler } from "../../src/widgets/listHandler";

function eventWith(tenantId: string | undefined): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("lista los widgets del tenant autenticado, consultando por pk+prefijo WIDGET#", async () => {
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

  const result = await handler(eventWith("t1"));

  const query = mockDdbSend.mock.calls[0][0].input;
  expect(query.ExpressionAttributeValues[":pk"]).toBe("TENANT#t1");
  expect(query.ExpressionAttributeValues[":prefix"]).toBe("WIDGET#");

  const body = JSON.parse(result.body);
  expect(body.widgets).toHaveLength(1);
  expect(body.widgets[0].widgetId).toBe("w1");
  expect(body.widgets[0].pk).toBeUndefined();
});

test("sin sesión de Cognito (sin claim de tenantId): 403", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});
