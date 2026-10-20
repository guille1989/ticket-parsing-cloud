import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TENANTS_TABLE: "TestTenants" };
});

import { resolveActiveTenantFromEvent, resolveActiveTenantIdFromEvent } from "../../src/shared/auth";

function eventWith(tenantId?: string): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId === undefined ? {} : { "custom:tenantId": tenantId } } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => mockDdbSend.mockReset());

test.each([undefined, "", "   "])("sin claim válido (%s) no consulta DynamoDB", async (tenantId) => {
  expect(await resolveActiveTenantIdFromEvent(eventWith(tenantId))).toBeUndefined();
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("un contexto sin authorizer se deniega sin consultar DynamoDB", async () => {
  expect(await resolveActiveTenantIdFromEvent({} as APIGatewayProxyWithCognitoAuthorizerEvent)).toBeUndefined();
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test.each([undefined, "active"])("permite un tenant existente con estado %s mediante lectura consistente", async (status) => {
  const tenant = { tenantId: "t1", businessName: "Negocio", status };
  mockDdbSend.mockResolvedValue({ Item: tenant });

  expect(await resolveActiveTenantFromEvent(eventWith("t1"))).toEqual(tenant);
  expect(mockDdbSend.mock.calls[0][0].input).toEqual({
    TableName: "TestTenants", Key: { pk: "TENANT#t1" }, ConsistentRead: true,
  });
});

test("el mismo JWT deja de autorizar al bloquear y vuelve a consultar en cada petición", async () => {
  const tokenIssuedBeforeBlock = eventWith("t1");
  mockDdbSend
    .mockResolvedValueOnce({ Item: { tenantId: "t1", status: "active" } })
    .mockResolvedValueOnce({ Item: { tenantId: "t1", status: "blocked" } })
    .mockResolvedValueOnce({ Item: { tenantId: "t1", status: "active" } });

  expect(await resolveActiveTenantIdFromEvent(tokenIssuedBeforeBlock)).toBe("t1");
  expect(await resolveActiveTenantIdFromEvent(tokenIssuedBeforeBlock)).toBeUndefined();
  expect(await resolveActiveTenantIdFromEvent(tokenIssuedBeforeBlock)).toBe("t1");
  expect(mockDdbSend).toHaveBeenCalledTimes(3);
  for (const [command] of mockDdbSend.mock.calls) expect(command.input.ConsistentRead).toBe(true);
});

test.each([
  {},
  { Item: { tenantId: "t1", status: "blocked" } },
  { Item: { tenantId: "t1", status: "unknown" } },
  { Item: { tenantId: "other", status: "active" } },
])("un tenant ausente, bloqueado o inconsistente se deniega (%j)", async (result) => {
  mockDdbSend.mockResolvedValue(result);
  expect(await resolveActiveTenantIdFromEvent(eventWith("t1"))).toBeUndefined();
});

test("un fallo de DynamoDB deniega acceso y registra un error sin el tenant ni el error original", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  mockDdbSend.mockRejectedValue(new Error("secret provider error"));
  try {
    expect(await resolveActiveTenantIdFromEvent(eventWith("private-tenant"))).toBeUndefined();
    expect(log).toHaveBeenCalledWith("No se pudo verificar el acceso al negocio");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-tenant");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret provider error");
  } finally {
    log.mockRestore();
  }
});
