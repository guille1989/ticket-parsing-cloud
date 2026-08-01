import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, WIDGETS_TABLE: "TestWidgets" };
});

import { handler } from "../../src/widgets/createHandler";

function eventWith(body: unknown, tenantId = "t1"): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
    body: body === undefined ? null : JSON.stringify(body),
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({});
});

test("crea un KPI válido sin groupBy", async () => {
  const result = await handler(
    eventWith({ name: "Total vendido", visualization: "kpi", metric: { field: "total", aggregation: "sum" } }),
  );

  expect(result.statusCode).toBe(201);
  const body = JSON.parse(result.body);
  expect(body.tenantId).toBe("t1");
  expect(body.widgetId).toBeTruthy();
  expect(body.name).toBe("Total vendido");
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
});

test("crea un widget de barras con groupBy y filtros", async () => {
  const result = await handler(
    eventWith({
      name: "Ventas por producto",
      visualization: "bar",
      metric: { field: "subtotal", aggregation: "sum" },
      groupBy: "description",
      filters: { dateFrom: "2026-07-01", port: "COM3" },
    }),
  );

  expect(result.statusCode).toBe(201);
  const body = JSON.parse(result.body);
  expect(body.groupBy).toBe("description");
  expect(body.filters).toEqual({ dateFrom: "2026-07-01", port: "COM3" });
});

test("rechaza un kpi con groupBy (no tiene sentido, no hay nada que agrupar)", async () => {
  const result = await handler(
    eventWith({ name: "X", visualization: "kpi", metric: { field: "total", aggregation: "sum" }, groupBy: "port" }),
  );
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("rechaza bar/donut sin groupBy", async () => {
  const result = await handler(
    eventWith({ name: "X", visualization: "bar", metric: { field: "total", aggregation: "sum" } }),
  );
  expect(result.statusCode).toBe(400);
});

// Un ticket real de 3 ítems y $3600 devolvía $10800 en el widget antes de
// este fix — total/discount/tip vienen repetidos por ítem, agruparlos por
// description no tiene una respuesta correcta posible.
test("rechaza agrupar un campo de TICKET (total/discount/tip) por description", async () => {
  const result = await handler(
    eventWith({
      name: "X",
      visualization: "bar",
      metric: { field: "total", aggregation: "sum" },
      groupBy: "description",
    }),
  );
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("permite agrupar un campo de TICKET (total) por un campo que no es description", async () => {
  const result = await handler(
    eventWith({ name: "X", visualization: "bar", metric: { field: "total", aggregation: "sum" }, groupBy: "port" }),
  );
  expect(result.statusCode).toBe(201);
});

test("rechaza un metric.field fuera de la lista blanca", async () => {
  const result = await handler(
    eventWith({ name: "X", visualization: "kpi", metric: { field: "password", aggregation: "sum" } }),
  );
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("rechaza una aggregation inválida", async () => {
  const result = await handler(
    eventWith({ name: "X", visualization: "kpi", metric: { field: "total", aggregation: "median" } }),
  );
  expect(result.statusCode).toBe(400);
});

test("rechaza un groupBy fuera de la lista blanca", async () => {
  const result = await handler(
    eventWith({ name: "X", visualization: "bar", metric: { field: "total", aggregation: "sum" }, groupBy: "'; --" }),
  );
  expect(result.statusCode).toBe(400);
});

test("rechaza name vacío", async () => {
  const result = await handler(
    eventWith({ name: "  ", visualization: "kpi", metric: { field: "total", aggregation: "sum" } }),
  );
  expect(result.statusCode).toBe(400);
});

test("rechaza filters.port con caracteres fuera de lo permitido", async () => {
  const result = await handler(
    eventWith({
      name: "X",
      visualization: "kpi",
      metric: { field: "total", aggregation: "sum" },
      filters: { port: "COM3; DROP TABLE" },
    }),
  );
  expect(result.statusCode).toBe(400);
});

test("sin sesión de Cognito (sin claim de tenantId): 403, no toca DynamoDB", async () => {
  const result = await handler(eventWith({}, ""));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("body no es JSON válido: 400", async () => {
  const result = await handler({
    requestContext: { authorizer: { claims: { "custom:tenantId": "t1" } } },
    body: "esto no es json",
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent);
  expect(result.statusCode).toBe(400);
});
