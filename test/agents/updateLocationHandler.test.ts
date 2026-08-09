import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, AGENTS_TABLE: "TestAgents" };
});

import { handler } from "../../src/agents/updateLocationHandler";

function event(body: unknown, tenantId = "t1", agentId = "a1"): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    body: JSON.stringify(body),
    pathParameters: { agentId },
    requestContext: { authorizer: { claims: { "custom:tenantId": tenantId } } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => mockDdbSend.mockReset());

test("guarda una ubicación validada dentro del tenant autenticado", async () => {
  mockDdbSend.mockResolvedValue({});
  const location = { label: "Sucursal Centro", city: "Madrid", lat: 40.4168, lng: -3.7038 };

  const result = await handler(event(location));

  expect(result.statusCode).toBe(200);
  const input = mockDdbSend.mock.calls[0][0].input;
  expect(input.Key).toEqual({ pk: "TENANT#t1", sk: "AGENT#a1" });
  expect(input.ExpressionAttributeValues).toEqual({ ":location": location });
  expect(input.ConditionExpression).toContain("attribute_exists");
});

test("rechaza coordenadas o textos incompletos", async () => {
  const result = await handler(event({ label: "", city: "Madrid", lat: 91, lng: -3.7 }));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("no permite modificar agentes de otro tenant por ausencia de identidad", async () => {
  const result = await handler(event({ label: "Centro", city: "Madrid", lat: 40.4, lng: -3.7 }, ""));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("responde 404 si el agente no existe en el tenant", async () => {
  mockDdbSend.mockRejectedValue({ name: "ConditionalCheckFailedException" });
  const result = await handler(event({ label: "Centro", city: "Madrid", lat: 40.4, lng: -3.7 }));
  expect(result.statusCode).toBe(404);
});
