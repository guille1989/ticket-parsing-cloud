import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockResolveAgent = jest.fn();
const mockLoadGlobalDesiredVersion = jest.fn();
const mockBuildUpdateSignal = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, AGENTS_TABLE: "TestAgents" };
});
jest.mock("../../src/shared/agent", () => ({
  resolveAgentByApiKeyId: (...args: unknown[]) => mockResolveAgent(...args),
}));
jest.mock("../../src/agents/otaPolicy", () => {
  const actual = jest.requireActual("../../src/agents/otaPolicy");
  return {
    ...actual,
    loadGlobalDesiredVersion: (...args: unknown[]) => mockLoadGlobalDesiredVersion(...args),
    buildUpdateSignal: (...args: unknown[]) => mockBuildUpdateSignal(...args),
  };
});

import { handler } from "../../src/agents/heartbeatHandler";

function event(apiKeyId?: string, body: unknown = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    requestContext: { identity: { apiKeyId } },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockResolveAgent.mockReset();
  mockLoadGlobalDesiredVersion.mockReset();
  mockBuildUpdateSignal.mockReset();
  mockLoadGlobalDesiredVersion.mockResolvedValue(undefined);
  mockBuildUpdateSignal.mockResolvedValue(undefined);
});

test("rechaza una API key que no pertenece a un agente", async () => {
  mockResolveAgent.mockResolvedValue(undefined);
  const result = await handler(event("unknown"));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("actualiza lastSeenAt, nombre, versión y ubicación del agente resuelto por la key", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  mockDdbSend.mockResolvedValue({});

  const result = await handler(event("key-1", {
    name: "Caja 1",
    version: "0.1.0",
    location: { label: "Sucursal Centro", city: "Madrid", lat: 40.4, lng: -3.7 },
  }));

  expect(result.statusCode).toBe(204);
  expect(mockResolveAgent).toHaveBeenCalledWith("key-1");
  const input = mockDdbSend.mock.calls[0][0].input;
  expect(input.Key).toEqual({ pk: "TENANT#t1", sk: "AGENT#a1" });
  expect(input.ExpressionAttributeValues).toMatchObject({
    ":name": "Caja 1",
    ":version": "0.1.0",
    ":location": { label: "Sucursal Centro", city: "Madrid", lat: 40.4, lng: -3.7 },
  });
  expect(input.ExpressionAttributeValues[":lastSeenAt"]).toEqual(expect.any(String));
});

test("valida coordenadas antes de escribir", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  const result = await handler(event("key-1", { location: { lat: 91 } }));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("rechaza version vacía o solo espacios", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  const result = await handler(event("key-1", { version: "   " }));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("persiste updateStatus y limpia updateError cuando no es error", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  mockDdbSend.mockResolvedValue({});

  const result = await handler(event("key-1", { version: "0.5.0", updateStatus: "ok" }));
  expect(result.statusCode).toBe(204);
  const input = mockDdbSend.mock.calls[0][0].input;
  expect(input.UpdateExpression).toContain("#updateStatus = :updateStatus");
  expect(input.UpdateExpression).toContain("REMOVE updateError");
  expect(input.ExpressionAttributeValues[":updateStatus"]).toBe("ok");
});

test("rechaza updateStatus desconocido", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  const result = await handler(event("key-1", { updateStatus: "hacked" }));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("devuelve señal update cuando desiredVersion difiere de la reportada", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  mockDdbSend.mockResolvedValue({});
  mockLoadGlobalDesiredVersion.mockResolvedValue("0.5.1");
  mockBuildUpdateSignal.mockResolvedValue({
    desiredVersion: "0.5.1",
    url: "https://example.test/app.mjs?X-Amz-Signature=abc",
    sha256: "a".repeat(64),
  });

  const result = await handler(event("key-1", { version: "0.5.0" }));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({
    update: {
      desiredVersion: "0.5.1",
      url: "https://example.test/app.mjs?X-Amz-Signature=abc",
      sha256: "a".repeat(64),
    },
  });
  expect(mockBuildUpdateSignal).toHaveBeenCalledWith("0.5.1");
});

test("no manda update si ya está en desiredVersion (kill-switch / idempotencia)", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
  mockDdbSend.mockResolvedValue({});
  mockLoadGlobalDesiredVersion.mockResolvedValue("0.5.0");

  const result = await handler(event("key-1", { version: "0.5.0" }));
  expect(result.statusCode).toBe(204);
  expect(mockBuildUpdateSignal).not.toHaveBeenCalled();
});

test("override desiredVersion del agent gana sobre la global", async () => {
  mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1", desiredVersion: "0.5.2" });
  mockDdbSend.mockResolvedValue({});
  mockLoadGlobalDesiredVersion.mockResolvedValue("0.5.1");
  mockBuildUpdateSignal.mockResolvedValue({
    desiredVersion: "0.5.2",
    url: "https://example.test/v",
    sha256: "b".repeat(64),
  });

  const result = await handler(event("key-1", { version: "0.5.0" }));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).update.desiredVersion).toBe("0.5.2");
  expect(mockBuildUpdateSignal).toHaveBeenCalledWith("0.5.2");
});
