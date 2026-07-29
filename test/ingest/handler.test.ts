import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockResolveTenantByApiKeyId = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return {
    ...actual,
    ddb: { send: (...args: unknown[]) => mockDdbSend(...args) },
    TICKETS_TABLE: "TestTickets",
    RAW_BUCKET: "test-bucket",
  };
});

jest.mock("../../src/shared/tenant", () => ({
  resolveTenantByApiKeyId: (...args: unknown[]) => mockResolveTenantByApiKeyId(...args),
}));

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockS3Send(...args) })),
  };
});

import { handler } from "../../src/ingest/handler";

const VALID_BODY = {
  ticketId: "5f2b9c3a-1111-4444-8888-abcdefabcdef",
  port: "COM3",
  capturedAt: "2026-07-27T23:00:00.000Z",
  rawText: "un ticket cualquiera",
};

function eventWith(apiKeyId: string | undefined, body: unknown): APIGatewayProxyEvent {
  return {
    requestContext: { identity: { apiKeyId } },
    body: body === undefined ? null : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

const validTenant = { tenantId: "t1", businessName: "Negocio", parserId: "example-38col", apiKeyId: "key1", createdAt: "2026-01-01T00:00:00.000Z" };

beforeEach(() => {
  mockDdbSend.mockReset();
  mockS3Send.mockReset();
  mockResolveTenantByApiKeyId.mockReset();
});

test("sin API key: 403, no toca S3 ni DynamoDB", async () => {
  const result = await handler(eventWith(undefined, VALID_BODY));
  expect(result.statusCode).toBe(403);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("API key no asociada a ningún tenant: 403", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(undefined);
  const result = await handler(eventWith("key-desconocida", VALID_BODY));
  expect(result.statusCode).toBe(403);
});

test("body que no es JSON válido: 400", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  const event = { requestContext: { identity: { apiKeyId: "key1" } }, body: "{esto no es json" } as unknown as APIGatewayProxyEvent;
  const result = await handler(event);
  expect(result.statusCode).toBe(400);
});

test("body inválido (falla validateBody): 400, no toca S3", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  const result = await handler(eventWith("key1", { ...VALID_BODY, ticketId: "no-es-uuid" }));
  expect(result.statusCode).toBe(400);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("request válido: guarda en S3, escritura condicional en DynamoDB, responde 202", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});

  const result = await handler(eventWith("key1", VALID_BODY));

  expect(result.statusCode).toBe(202);
  expect(JSON.parse(result.body)).toEqual({ ticketId: VALID_BODY.ticketId });

  expect(mockS3Send).toHaveBeenCalledTimes(1);
  const s3Call = mockS3Send.mock.calls[0][0].input;
  expect(s3Call.Key).toBe(`tenants/t1/${VALID_BODY.ticketId}.txt`);
  expect(s3Call.Body).toBe(VALID_BODY.rawText);

  expect(mockDdbSend).toHaveBeenCalledTimes(1);
  const ddbCall = mockDdbSend.mock.calls[0][0].input;
  expect(ddbCall.ConditionExpression).toBe("attribute_not_exists(pk)");
  expect(ddbCall.Item.status).toBe("pending");
});

// El caso central del fix de idempotencia: el agente reintenta con el
// MISMO ticketId (no sabe si el fallo anterior fue antes o después de que
// el servidor procesara el pedido). Antes, esto generaba un ticketId
// nuevo cada vez y duplicaba el registro.
test("reintento con el mismo ticketId (ConditionalCheckFailedException): sigue respondiendo 202, no explota", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockRejectedValue(
    new ConditionalCheckFailedException({ message: "ya existe", $metadata: {} }),
  );

  const result = await handler(eventWith("key1", VALID_BODY));

  expect(result.statusCode).toBe(202);
  expect(JSON.parse(result.body)).toEqual({ ticketId: VALID_BODY.ticketId });
});

test("un error de DynamoDB que NO es de condición se propaga (no se traga silenciosamente)", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockRejectedValue(new Error("DynamoDB no disponible"));

  await expect(handler(eventWith("key1", VALID_BODY))).rejects.toThrow("DynamoDB no disponible");
});
