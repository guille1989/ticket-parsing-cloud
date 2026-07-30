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

import { handler } from "../../src/widgets/createHandler";

const validTenant = { tenantId: "t1", businessName: "Negocio", parserId: "example-38col", apiKeyId: "key1", createdAt: "2026-01-01T00:00:00.000Z" };

function eventWith(body: unknown): APIGatewayProxyEvent {
  return {
    requestContext: { identity: { apiKeyId: "key1" } },
    body: body === undefined ? null : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockResolveTenantByApiKeyId.mockReset();
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
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

test("sin API key: 403, no toca DynamoDB", async () => {
  const result = await handler({ requestContext: { identity: {} }, body: "{}" } as unknown as APIGatewayProxyEvent);
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("body no es JSON válido: 400", async () => {
  const result = await handler({
    requestContext: { identity: { apiKeyId: "key1" } },
    body: "esto no es json",
  } as unknown as APIGatewayProxyEvent);
  expect(result.statusCode).toBe(400);
});
