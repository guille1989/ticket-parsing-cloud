import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, AGENTS_TABLE: "TestAgents" };
});

import { handler } from "../../src/agents/listHandler";

function eventWith(tenantId: string | undefined): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("sin sesión de Cognito (sin claim de tenantId): 403", async () => {
  const result = await handler(eventWith(undefined));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("lista los agentes del tenant, recortados a campos públicos", async () => {
  mockDdbSend.mockResolvedValue({
    Items: [
      { tenantId: "t1", agentId: "a1", name: "Caja 1", apiKeyId: "internal-key-1", createdAt: "2026-01-01T00:00:00.000Z" },
      { tenantId: "t1", agentId: "a2", name: "Caja 2", apiKeyId: "internal-key-2", createdAt: "2026-01-02T00:00:00.000Z", lastSeenAt: "2026-01-03T00:00:00.000Z" },
    ],
  });

  const result = await handler(eventWith("t1"));

  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.agents).toEqual([
    { agentId: "a1", name: "Caja 1", createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: undefined },
    { agentId: "a2", name: "Caja 2", createdAt: "2026-01-02T00:00:00.000Z", lastSeenAt: "2026-01-03T00:00:00.000Z" },
  ]);
  // Nunca se expone el apiKeyId interno de cada agente.
  expect(JSON.stringify(body)).not.toContain("internal-key");

  const ddbCall = mockDdbSend.mock.calls[0][0].input;
  expect(ddbCall.ExpressionAttributeValues[":pk"]).toBe("TENANT#t1");
  expect(ddbCall.ExpressionAttributeValues[":prefix"]).toBe("AGENT#");
});

test("tenant sin agentes: lista vacía, no undefined", async () => {
  mockDdbSend.mockResolvedValue({});

  const result = await handler(eventWith("t1"));

  expect(JSON.parse(result.body)).toEqual({ agents: [] });
});
