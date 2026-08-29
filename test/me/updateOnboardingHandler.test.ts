import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockGetTenant = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TENANTS_TABLE: "TestTenants", AGENTS_TABLE: "TestAgents", WIDGETS_TABLE: "TestWidgets" };
});
jest.mock("../../src/shared/tenant", () => ({ getTenant: (...args: unknown[]) => mockGetTenant(...args) }));

import { handler } from "../../src/me/updateOnboardingHandler";

function event(action: string, tenantId = "t1"): APIGatewayProxyWithCognitoAuthorizerEvent {
  return { body: JSON.stringify({ action }), requestContext: { authorizer: { claims: { "custom:tenantId": tenantId } } } } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetTenant.mockReset();
  mockGetTenant.mockResolvedValue({ tenantId: "t1", businessName: "Negocio", createdAt: "2026-08-12T10:00:00.000Z", onboarding: { version: 1 } });
  mockDdbSend.mockResolvedValue({});
});

test("inicia el onboarding y lo persiste", async () => {
  const result = await handler(event("start"));
  expect(result.statusCode).toBe(200);
  const state = JSON.parse(result.body).onboarding;
  expect(state.version).toBe(1);
  expect(state.startedAt).toEqual(expect.any(String));
  expect(mockDdbSend.mock.calls[0][0].constructor.name).toBe("UpdateCommand");
});

test("no permite finalizar sin un agente activado", async () => {
  mockDdbSend.mockResolvedValueOnce({ Items: [] });
  const result = await handler(event("complete"));
  expect(result.statusCode).toBe(409);
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
});

test("finaliza cuando hay un agente activado aunque el primer heartbeat aún no haya llegado", async () => {
  mockDdbSend.mockResolvedValueOnce({ Items: [{ agentId: "a1" }] }).mockResolvedValueOnce({});
  const result = await handler(event("complete"));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).onboarding.completedAt).toEqual(expect.any(String));
});

test("crea tres widgets iniciales en una única transacción", async () => {
  const result = await handler(event("create-starter-dashboard"));
  expect(result.statusCode).toBe(200);
  const input = mockDdbSend.mock.calls[0][0].input;
  expect(input.TransactItems).toHaveLength(4);
  const puts = input.TransactItems.slice(1).map((item: any) => item.Put.Item);
  expect(puts.map((widget: any) => widget.name)).toEqual(["Tickets procesados", "Ventas totales", "Evolución de ventas"]);
  expect(new Set(puts.map((widget: any) => widget.widgetId)).size).toBe(3);
});

test("no duplica el dashboard inicial si ya fue creado", async () => {
  mockGetTenant.mockResolvedValue({ tenantId: "t1", onboarding: { version: 1, starterDashboardCreatedAt: "2026-08-12T10:00:00.000Z" } });
  const result = await handler(event("create-starter-dashboard"));
  expect(result.statusCode).toBe(200);
  expect(mockDdbSend).not.toHaveBeenCalled();
});
