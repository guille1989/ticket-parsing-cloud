import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

// La guardia de tenant activo tiene cobertura de integración independiente.
jest.mock("../../src/shared/auth", () => ({
  resolveActiveTenantFromEvent: async (event: APIGatewayProxyWithCognitoAuthorizerEvent) => {
    const tenantId = event.requestContext?.authorizer?.claims?.["custom:tenantId"];
    return tenantId ? { tenantId, userViews: { "own-user": { suggestedPrompts: [{ q: "¿Cuánto vendí hoy?", label: "Hoy" }] } } } : undefined;
  },
  resolveUserIdFromEvent: (event: APIGatewayProxyWithCognitoAuthorizerEvent) => event.requestContext?.authorizer?.claims?.sub,
}));

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, WIDGETS_TABLE: "TestWidgets" };
});

import { handler } from "../../src/widgets/deleteHandler";

function eventWith(widgetId: string | undefined): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: { "custom:tenantId": "t1" } } },
    pathParameters: widgetId ? { widgetId } : null,
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
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

test("sin sesión de Cognito (sin claim de tenantId): 403, no toca DynamoDB", async () => {
  const result = await handler({
    requestContext: { authorizer: { claims: {} } },
    pathParameters: { widgetId: "w1" },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent);
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

describe("vista propia por persona", () => {
  const withSub = (sub: string) => ({ requestContext: { authorizer: { claims: { "custom:tenantId": "t1", sub } } }, pathParameters: { widgetId: "w1" } }) as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;

  test("quien tiene vista propia solo borra widgets suyos", async () => {
    await handler(withSub("own-user"));
    const del = mockDdbSend.mock.calls[0][0].input;
    expect(del.ConditionExpression).toBe("userId = :userId");
    expect(del.ExpressionAttributeValues).toEqual({ ":userId": "own-user" });
  });

  test("el resto solo borra widgets compartidos", async () => {
    await handler(withSub("alguien-mas"));
    expect(mockDdbSend.mock.calls[0][0].input.ConditionExpression).toBe("attribute_not_exists(userId)");
  });

  test("un widget ajeno (condición falla) no se borra y responde 204 igual", async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect((await handler(withSub("own-user"))).statusCode).toBe(204);
  });
});
