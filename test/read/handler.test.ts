import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets" };
});

import { handler } from "../../src/read/handler";

function eventWith(
  tenantId: string | undefined,
  query: Record<string, string> = {},
): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
    queryStringParameters: query,
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

test("status inválido en query: 400, no consulta DynamoDB", async () => {
  const result = await handler(eventWith("t1", { status: "no-existe" }));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("sin filtro: consulta por pk del tenant autenticado, nunca por uno del query", async () => {
  mockDdbSend.mockResolvedValue({ Items: [] });

  // el query trae un tenantId ajeno a propósito — no debe usarse para nada
  await handler(eventWith("t1", { tenantId: "otro-tenant" } as unknown as Record<string, string>));

  const query = mockDdbSend.mock.calls[0][0].input;
  expect(query.ExpressionAttributeValues[":pk"]).toBe("TENANT#t1");
  expect(query.IndexName).toBeUndefined();
});

test("con filtro status: consulta el GSI status-index", async () => {
  mockDdbSend.mockResolvedValue({ Items: [] });

  await handler(eventWith("t1", { status: "parsed" }));

  const query = mockDdbSend.mock.calls[0][0].input;
  expect(query.IndexName).toBe("status-index");
  expect(query.ExpressionAttributeValues[":gsi1pk"]).toBe("TENANT#t1#STATUS#parsed");
});

test("needs_review es un filtro de status válido", async () => {
  mockDdbSend.mockResolvedValue({ Items: [] });

  const result = await handler(eventWith("t1", { status: "needs_review" }));

  expect(result.statusCode).toBe(200);
  const query = mockDdbSend.mock.calls[0][0].input;
  expect(query.ExpressionAttributeValues[":gsi1pk"]).toBe("TENANT#t1#STATUS#needs_review");
});

test("un ticket needs_review expone parsedBy para que el negocio sepa que viene de Bedrock", async () => {
  mockDdbSend.mockResolvedValue({
    Items: [
      {
        pk: "TENANT#t1",
        sk: "TICKET#2026-07-29T12:00:00.000Z#tk2",
        gsi1pk: "TENANT#t1#STATUS#needs_review",
        gsi1sk: "2026-07-29T12:00:00.000Z",
        rawS3Key: "tenants/t1/tk2.txt",
        tenantId: "t1",
        ticketId: "tk2",
        port: "datafono-1",
        capturedAt: "2026-07-29T12:00:00.000Z",
        status: "needs_review",
        total: 900,
        parsedBy: "bedrock-fallback",
      },
    ],
  });

  const result = await handler(eventWith("t1", { status: "needs_review" }));
  const body = JSON.parse(result.body);

  expect(body.tickets[0].status).toBe("needs_review");
  expect(body.tickets[0].parsedBy).toBe("bedrock-fallback");
});

test("la respuesta no expone claves internas de DynamoDB (pk/sk/rawS3Key)", async () => {
  mockDdbSend.mockResolvedValue({
    Items: [
      {
        pk: "TENANT#t1",
        sk: "TICKET#2026-07-27T12:00:00.000Z#tk1",
        gsi1pk: "TENANT#t1#STATUS#parsed",
        gsi1sk: "2026-07-27T12:00:00.000Z",
        rawS3Key: "tenants/t1/tk1.txt",
        tenantId: "t1",
        ticketId: "tk1",
        port: "COM3",
        capturedAt: "2026-07-27T12:00:00.000Z",
        status: "parsed",
        total: 3450,
      },
    ],
  });

  const result = await handler(eventWith("t1"));
  const body = JSON.parse(result.body);

  expect(body.tickets).toHaveLength(1);
  expect(body.tickets[0]).toEqual({
    ticketId: "tk1",
    port: "COM3",
    capturedAt: "2026-07-27T12:00:00.000Z",
    status: "parsed",
    total: 3450,
  });
  expect(body.tickets[0].pk).toBeUndefined();
  expect(body.tickets[0].rawS3Key).toBeUndefined();
});

test("paginación: nextCursor viaja codificado y limit se acota al máximo", async () => {
  mockDdbSend.mockResolvedValue({ Items: [], LastEvaluatedKey: { pk: "TENANT#t1", sk: "TICKET#x" } });

  const result = await handler(eventWith("t1", { limit: "9999" }));

  const query = mockDdbSend.mock.calls[0][0].input;
  expect(query.Limit).toBe(100); // MAX_LIMIT, no lo que pidió el query

  const body = JSON.parse(result.body);
  expect(typeof body.nextCursor).toBe("string");
  const decoded = JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf-8"));
  expect(decoded).toEqual({ pk: "TENANT#t1", sk: "TICKET#x" });
});
