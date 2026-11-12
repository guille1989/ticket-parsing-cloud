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

test("recorre todas las páginas de DynamoDB, no solo la primera", async () => {
  const widget = (id: string) => ({ tenantId: "t1", widgetId: id, name: id, visualization: "kpi", metric: { field: "total", aggregation: "sum" }, createdAt: "2026-07-29T20:00:00.000Z" });
  mockDdbSend
    .mockResolvedValueOnce({ Items: [widget("w1")], LastEvaluatedKey: { pk: "TENANT#t1", sk: "WIDGET#w1" } })
    .mockResolvedValueOnce({ Items: [widget("w2")] });

  const result = await handler(eventWith("t1"));

  expect(JSON.parse(result.body).widgets.map((w: { widgetId: string }) => w.widgetId)).toEqual(["w1", "w2"]);
  expect(mockDdbSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ pk: "TENANT#t1", sk: "WIDGET#w1" });
});

test("devuelve la secondaryMetric de un KPI", async () => {
  mockDdbSend.mockResolvedValue({
    Items: [
      {
        pk: "TENANT#t1",
        sk: "WIDGET#w1",
        tenantId: "t1",
        widgetId: "w1",
        name: "Agua 5 L",
        visualization: "kpi",
        metric: { field: "subtotal", aggregation: "sum" },
        secondaryMetric: { field: "quantity", aggregation: "sum" },
        createdAt: "2026-07-29T20:00:00.000Z",
      },
    ],
  });

  const result = await handler(eventWith("t1"));

  expect(JSON.parse(result.body).widgets[0].secondaryMetric).toEqual({ field: "quantity", aggregation: "sum" });
});

describe("vista propia por persona", () => {
  const shared = { pk: "TENANT#t1", sk: "WIDGET#s1", tenantId: "t1", widgetId: "s1", name: "Compartido", visualization: "kpi", metric: { field: "total", aggregation: "sum" }, createdAt: "2026-07-29T20:00:00.000Z" };
  const own = { ...shared, sk: "WIDGET#o1", widgetId: "o1", name: "Propio", userId: "own-user" };
  const ofOther = { ...shared, sk: "WIDGET#x1", widgetId: "x1", name: "De otra persona", userId: "otra" };
  const withSub = (sub: string) => ({ requestContext: { authorizer: { claims: { "custom:tenantId": "t1", sub } } } }) as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;

  test("quien tiene vista propia ve solo los suyos, no los compartidos", async () => {
    mockDdbSend.mockResolvedValue({ Items: [shared, own, ofOther] });
    const body = JSON.parse((await handler(withSub("own-user"))).body);
    expect(body.widgets.map((w: { widgetId: string }) => w.widgetId)).toEqual(["o1"]);
  });

  test("el resto del negocio ve solo los compartidos, nunca los de una vista propia", async () => {
    mockDdbSend.mockResolvedValue({ Items: [shared, own, ofOther] });
    const body = JSON.parse((await handler(withSub("alguien-mas"))).body);
    expect(body.widgets.map((w: { widgetId: string }) => w.widgetId)).toEqual(["s1"]);
  });
});
