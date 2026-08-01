import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, ACTIVATION_CODES_TABLE: "TestActivationCodes" };
});

import { handler } from "../../src/agents/codesHandler";

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

test("lista los 5 códigos del tenant, usados y sin usar, vía el GSI de tenantId", async () => {
  mockDdbSend.mockResolvedValue({
    Items: [
      { tenantId: "t1", code: "AAAAA-AAAAA", status: "unused", createdAt: "2026-01-01T00:00:00.000Z" },
      { tenantId: "t1", code: "BBBBB-BBBBB", status: "used", createdAt: "2026-01-01T00:00:00.000Z", usedAt: "2026-01-02T00:00:00.000Z", agentId: "a1" },
    ],
  });

  const result = await handler(eventWith("t1"));

  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.codes).toHaveLength(2);
  expect(body.codes[1]).toEqual({
    code: "BBBBB-BBBBB",
    status: "used",
    createdAt: "2026-01-01T00:00:00.000Z",
    usedAt: "2026-01-02T00:00:00.000Z",
    agentId: "a1",
  });

  const ddbCall = mockDdbSend.mock.calls[0][0].input;
  expect(ddbCall.IndexName).toBe("tenantId-index");
  expect(ddbCall.ExpressionAttributeValues[":tenantId"]).toBe("t1");
});
