import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockWriteAnalyticsRows = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets", ANALYTICS_BUCKET: "test-analytics" };
});

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockS3Send(...args) })) };
});

jest.mock("../../src/analytics/writeAnalyticsRows", () => {
  const actual = jest.requireActual("../../src/analytics/writeAnalyticsRows");
  return { ...actual, writeAnalyticsRows: (...args: unknown[]) => mockWriteAnalyticsRows(...args) };
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
  mockS3Send.mockReset();
  mockWriteAnalyticsRows.mockReset();
});

test("sin API — sin claim de tenant: 403, no toca DynamoDB ni S3", async () => {
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

test("confirm: promueve needs_review a parsed y reescribe la fila de analítica", async () => {
  mockDdbSend.mockResolvedValue({ Attributes: NEEDS_REVIEW_TICKET });

  const result = await handler(event({ action: "confirm", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ ticketId: TICKET_ID, status: "parsed" });

  const updateInput = mockDdbSend.mock.calls[0][0].input;
  expect(updateInput.Key).toEqual({ pk: "TENANT#t1", sk: `TICKET#${CAPTURED_AT}#${TICKET_ID}` });
  expect(updateInput.ConditionExpression).toBe("#status = :needsReview");
  expect(updateInput.ExpressionAttributeValues[":newStatus"]).toBe("parsed");

  expect(mockWriteAnalyticsRows).toHaveBeenCalledTimes(1);
  const [bucket, ctx, parsed] = mockWriteAnalyticsRows.mock.calls[0];
  expect(bucket).toBe("test-analytics");
  expect(ctx).toMatchObject({ tenantId: "t1", ticketId: TICKET_ID, status: "parsed", parsedBy: "bedrock-vision" });
  expect(parsed.items).toEqual(NEEDS_REVIEW_TICKET.items);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("discard: manda a discarded y borra la fila de analítica (no la reescribe)", async () => {
  mockDdbSend.mockResolvedValue({ Attributes: { ...NEEDS_REVIEW_TICKET, status: "discarded" } });
  mockS3Send.mockResolvedValue({});

  const result = await handler(event({ action: "discard", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ ticketId: TICKET_ID, status: "discarded" });

  const updateInput = mockDdbSend.mock.calls[0][0].input;
  expect(updateInput.ExpressionAttributeValues[":newStatus"]).toBe("discarded");

  expect(mockS3Send).toHaveBeenCalledTimes(1);
  const deleteInput = mockS3Send.mock.calls[0][0].input;
  expect(deleteInput.Bucket).toBe("test-analytics");
  expect(deleteInput.Key).toBe(`tenant=t1/year=2026/month=09/${TICKET_ID}.jsonl`);
  expect(mockWriteAnalyticsRows).not.toHaveBeenCalled();
});

test("confirm de un ticket needs_review sin items: no explota, no llama writeAnalyticsRows", async () => {
  mockDdbSend.mockResolvedValue({ Attributes: { ...NEEDS_REVIEW_TICKET, items: undefined } });

  const result = await handler(event({ action: "confirm", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(200);
  expect(mockWriteAnalyticsRows).not.toHaveBeenCalled();
});

// El caso central: un ticket que no está en needs_review (ya se revisó, o
// nunca existió) no se puede confirmar/descartar de nuevo.
test("ticket que no está en needs_review (ConditionalCheckFailedException): 409, no toca S3", async () => {
  mockDdbSend.mockRejectedValue({ name: "ConditionalCheckFailedException" });

  const result = await handler(event({ action: "confirm", capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(409);
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockWriteAnalyticsRows).not.toHaveBeenCalled();
});

test("un error de DynamoDB que NO es de condición se propaga", async () => {
  mockDdbSend.mockRejectedValue(new Error("DynamoDB no disponible"));
  await expect(handler(event({ action: "confirm", capturedAt: CAPTURED_AT }))).rejects.toThrow("DynamoDB no disponible");
});
