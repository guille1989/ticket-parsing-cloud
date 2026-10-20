import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

// La autorización se verifica con el helper real en shared/humanAuthorization.test.ts.
jest.mock("../../src/shared/auth", () => ({
  resolveActiveTenantIdFromEvent: jest.fn(async (event: APIGatewayProxyWithCognitoAuthorizerEvent) =>
    event.requestContext?.authorizer?.claims?.["custom:tenantId"]),
}));

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets" };
});

import { handler } from "../../src/review/handler";

const TICKET_ID = "5f2b9c3a-1111-4444-8888-abcdefabcdef";
const CAPTURED_AT = "2026-09-14T22:56:42.633Z";

function event(body: unknown, tenantId = "t1", ticketId = TICKET_ID): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    body: body === undefined ? null : JSON.stringify(body),
    pathParameters: { ticketId },
    requestContext: { authorizer: { claims: { "custom:tenantId": tenantId } } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

const NEEDS_REVIEW_TICKET = {
  tenantId: "t1",
  ticketId: TICKET_ID,
  port: "EPSON TM-T20II Receipt",
  status: "parsed",
  parsedBy: "bedrock-vision" as const,
  items: [{ description: "Empanada de Pollo", quantity: 1, unitPrice: 4600, subtotal: 4600, voided: false }],
  total: 4600,
  tax: 734,
};

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("sin API — sin claim de tenant: 403, no toca DynamoDB", async () => {
  const result = await handler(event({ action: "confirm", capturedAt: CAPTURED_AT }, ""));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("falta ticketId en el path: 400", async () => {
  const e = event({ action: "confirm", capturedAt: CAPTURED_AT });
  e.pathParameters = {};
  const result = await handler(e);
  expect(result.statusCode).toBe(400);
});

test.each([
  [{ action: "otra-cosa", capturedAt: CAPTURED_AT }],
  [{ action: "confirm" }],
  [{ capturedAt: CAPTURED_AT }],
  [undefined],
])("body inválido %j: 400, no toca DynamoDB", async (body) => {
  const result = await handler(event(body));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("confirm: promueve needs_review a parsed (la analítica la reescribe el consumidor del Stream)", async () => {
  mockDdbSend.mockResolvedValue({ Attributes: NEEDS_REVIEW_TICKET });

  const result = await handler(event({ action: "confirm", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ ticketId: TICKET_ID, status: "parsed" });

  expect(mockDdbSend).toHaveBeenCalledTimes(1);
  const updateInput = mockDdbSend.mock.calls[0][0].input;
  expect(updateInput.Key).toEqual({ pk: "TENANT#t1", sk: `TICKET#${CAPTURED_AT}#${TICKET_ID}` });
  expect(updateInput.ConditionExpression).toBe("#status = :needsReview");
  expect(updateInput.ExpressionAttributeValues[":newStatus"]).toBe("parsed");
});

test("discard: manda a discarded con una sola escritura a DynamoDB; el borrado de la analítica lo hace el consumidor", async () => {
  mockDdbSend.mockResolvedValue({ Attributes: { ...NEEDS_REVIEW_TICKET, status: "discarded" } });

  const result = await handler(event({ action: "discard", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ ticketId: TICKET_ID, status: "discarded" });
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
  const updateInput = mockDdbSend.mock.calls[0][0].input;
  expect(updateInput.ExpressionAttributeValues[":newStatus"]).toBe("discarded");
  expect(updateInput.ExpressionAttributeValues[":gsi1pk"]).toBe("TENANT#t1#STATUS#discarded");
});

// El caso central: un ticket que no está en needs_review (ya se revisó, o
// nunca existió) no se puede confirmar/descartar de nuevo.
test("ticket que no está en needs_review (ConditionalCheckFailedException): 409", async () => {
  mockDdbSend.mockRejectedValue({ name: "ConditionalCheckFailedException" });

  const result = await handler(event({ action: "confirm", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(409);
});

test("un error de DynamoDB que NO es de condición se propaga", async () => {
  mockDdbSend.mockRejectedValue(new Error("DynamoDB no disponible"));
  await expect(handler(event({ action: "confirm", capturedAt: CAPTURED_AT }))).rejects.toThrow("DynamoDB no disponible");
});
