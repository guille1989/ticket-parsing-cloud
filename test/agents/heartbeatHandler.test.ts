import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockResolveAgent = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, AGENTS_TABLE: "TestAgents" };
});
jest.mock("../../src/shared/agent", () => ({
  resolveAgentByApiKeyId: (...args: unknown[]) => mockResolveAgent(...args),
}));

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
