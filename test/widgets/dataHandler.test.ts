import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockResolveTenantByApiKeyId = jest.fn();
const mockRunWidgetQuery = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return {
    ...actual,
    ddb: { send: (...args: unknown[]) => mockDdbSend(...args) },
    WIDGETS_TABLE: "TestWidgets",
    ATHENA_WORKGROUP: "test-workgroup",
  };
});

jest.mock("../../src/shared/tenant", () => ({
  resolveTenantByApiKeyId: (...args: unknown[]) => mockResolveTenantByApiKeyId(...args),
}));

jest.mock("../../src/widgets/athenaQuery", () => ({
  runWidgetQuery: (...args: unknown[]) => mockRunWidgetQuery(...args),
}));

import { handler } from "../../src/widgets/dataHandler";

const validTenant = { tenantId: "t1", businessName: "Negocio", parserId: "example-38col", apiKeyId: "key1", createdAt: "2026-01-01T00:00:00.000Z" };

const validWidget = {
  tenantId: "t1",
  widgetId: "w1",
  name: "Ventas por producto",
  visualization: "bar",
  metric: { field: "subtotal", aggregation: "sum" },
  groupBy: "description",
  createdAt: "2026-07-29T20:00:00.000Z",
};

function eventWith(widgetId: string | undefined): APIGatewayProxyEvent {
  return {
    requestContext: { identity: { apiKeyId: "key1" } },
    pathParameters: widgetId ? { widgetId } : null,
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockResolveTenantByApiKeyId.mockReset();
  mockRunWidgetQuery.mockReset();
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
});

test("corre la consulta de Athena para el widget guardado y devuelve los datos", async () => {
  mockDdbSend.mockResolvedValue({ Item: validWidget });
  mockRunWidgetQuery.mockResolvedValue([
    { label: "Café", value: 1800 },
    { label: "Medialuna", value: 900 },
  ]);

  const result = await handler(eventWith("w1"));

  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.widgetId).toBe("w1");
  expect(body.visualization).toBe("bar");
  expect(body.data).toHaveLength(2);

  // El workgroup viaja tal cual lo expone el módulo de dynamo compartido.
  expect(mockRunWidgetQuery).toHaveBeenCalledWith(expect.any(String), expect.any(Array), "test-workgroup");
});

test("widget inexistente: 404, nunca llega a llamar a Athena", async () => {
  mockDdbSend.mockResolvedValue({ Item: undefined });

  const result = await handler(eventWith("no-existe"));

  expect(result.statusCode).toBe(404);
  expect(mockRunWidgetQuery).not.toHaveBeenCalled();
});

test("un widget con config corrupta (campo fuera de la lista blanca) da 500 en vez de generar SQL inseguro", async () => {
  mockDdbSend.mockResolvedValue({ Item: { ...validWidget, metric: { field: "'; DROP TABLE ticket_items; --", aggregation: "sum" } } });

  const result = await handler(eventWith("w1"));

  expect(result.statusCode).toBe(500);
  expect(mockRunWidgetQuery).not.toHaveBeenCalled();
});

test("sin widgetId en el path: 400", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});
