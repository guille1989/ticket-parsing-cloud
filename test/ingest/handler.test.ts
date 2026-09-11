import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockResolveTenantByApiKeyId = jest.fn();
const mockResolveAgentByApiKeyId = jest.fn();
const mockGetTenant = jest.fn();

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
  getTenant: (...args: unknown[]) => mockGetTenant(...args),
}));

// Mockeado aparte (no solo vía `ddb`) para no meter una llamada extra a
// mockDdbSend en cada test existente — la mayoría de los tests de este
// archivo simulan la api-key COMPARTIDA del tenant, no la de un agente, así
// que por defecto esto resuelve "no es un agente" y cae al camino de
// siempre. Los tests específicos del camino de agente lo pisan.
jest.mock("../../src/shared/agent", () => ({
  resolveAgentByApiKeyId: (...args: unknown[]) => mockResolveAgentByApiKeyId(...args),
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
  mockResolveAgentByApiKeyId.mockReset();
  mockGetTenant.mockReset();
  mockResolveAgentByApiKeyId.mockResolvedValue(undefined);
  // Por defecto, el tenant que resuelve un agente no está bloqueado — los
  // tests de bloqueo lo pisan explícitamente.
  mockGetTenant.mockResolvedValue({ status: "active" });
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

  // 2 escrituras: el marcador de deduplicación de contenido y el ticket en sí.
  expect(mockDdbSend).toHaveBeenCalledTimes(2);
  const dedupCall = mockDdbSend.mock.calls[0][0].input;
  expect(dedupCall.ConditionExpression).toBe("attribute_not_exists(pk)");
  expect(dedupCall.Item.sk).toMatch(/^DEDUP#/);
  const ddbCall = mockDdbSend.mock.calls[1][0].input;
  expect(ddbCall.ConditionExpression).toBe("attribute_not_exists(pk)");
  expect(ddbCall.Item.status).toBe("pending");
});

// Loggro (POS de Empanadas Típicas) reenvía a veces el mismo ticket como un
// job de impresión de Windows nuevo segundos después del original, aunque
// la impresora solo sacó un papel — sin esto se facturaba la venta dos
// veces. Ver DEDUP_WINDOW_SECONDS en el handler.
test("contenido idéntico al de un ticket reciente del mismo puerto: se descarta, no toca S3 ni crea otro ticket", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockDdbSend.mockRejectedValue(
    new ConditionalCheckFailedException({ message: "ya existe", $metadata: {} }),
  );

  const result = await handler(eventWith("key1", VALID_BODY));

  expect(result.statusCode).toBe(202);
  expect(JSON.parse(result.body)).toEqual({ ticketId: VALID_BODY.ticketId, duplicate: true });
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
});

test("captura de spool (rawBase64/escpos): guarda los BYTES en S3 como .escpos y marca rawKind", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});

  const bytes = Buffer.from("\x1b@VENTA\x1dV\x00", "latin1");
  const { rawText: _drop, ...bodyNoText } = VALID_BODY;
  const result = await handler(
    eventWith("key1", { ...bodyNoText, rawBase64: bytes.toString("base64"), rawEncoding: "escpos" }),
  );

  expect(result.statusCode).toBe(202);
  const s3Call = mockS3Send.mock.calls[0][0].input;
  expect(s3Call.Key).toBe(`tenants/t1/${VALID_BODY.ticketId}.escpos`);
  expect(s3Call.ContentType).toBe("application/octet-stream");
  expect(Buffer.isBuffer(s3Call.Body)).toBe(true);
  expect((s3Call.Body as Buffer).equals(bytes)).toBe(true);

  const ddbItem = mockDdbSend.mock.calls[1][0].input.Item;
  expect(ddbItem.rawKind).toBe("escpos");
  expect(ddbItem.rawS3Key).toBe(`tenants/t1/${VALID_BODY.ticketId}.escpos`);
});

test("captura de texto: rawKind queda en 'text' y la key sigue siendo .txt", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});

  await handler(eventWith("key1", VALID_BODY));

  const s3Call = mockS3Send.mock.calls[0][0].input;
  expect(s3Call.Key).toBe(`tenants/t1/${VALID_BODY.ticketId}.txt`);
  expect(mockDdbSend.mock.calls[1][0].input.Item.rawKind).toBe("text");
});

// El caso central del fix de idempotencia: el agente reintenta con el
// MISMO ticketId (no sabe si el fallo anterior fue antes o después de que
// el servidor procesara el pedido). Antes, esto generaba un ticketId
// nuevo cada vez y duplicaba el registro.
test("reintento con el mismo ticketId (ConditionalCheckFailedException): sigue respondiendo 202, no explota", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({});
  // El marcador de deduplicación de contenido pasa (ej. el reintento llegó
  // después de que expiró la ventana), pero el ticket en sí ya existía con
  // ese mismo id — es el caso que este test cubre.
  mockDdbSend
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "ya existe", $metadata: {} }));

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

// Un robot activado por código (ver agents/activateHandler.ts) sube con su
// propia api-key, no la del tenant — pero igual hace falta consultar
// Tenants para saber si está bloqueado (el registro del agente no trae ese
// dato), ver el test de bloqueo más abajo.
test("api-key de un agente: resuelve el tenantId del agente, sin usar la api-key compartida", async () => {
  mockResolveAgentByApiKeyId.mockResolvedValue({ tenantId: "t-agente", agentId: "a1", name: "Robot 1", apiKeyId: "agent-key-1", createdAt: "2026-01-01T00:00:00.000Z" });
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});

  const result = await handler(eventWith("agent-key-1", VALID_BODY));

  expect(result.statusCode).toBe(202);
  expect(mockResolveTenantByApiKeyId).not.toHaveBeenCalled();
  expect(mockGetTenant).toHaveBeenCalledWith("t-agente");
  const s3Call = mockS3Send.mock.calls[0][0].input;
  expect(s3Call.Key).toBe(`tenants/t-agente/${VALID_BODY.ticketId}.txt`);
  const ddbCall = mockDdbSend.mock.calls[1][0].input;
  expect(ddbCall.Item.tenantId).toBe("t-agente");
});

test("api-key que no es de ningún agente NI de ningún tenant: 403", async () => {
  mockResolveAgentByApiKeyId.mockResolvedValue(undefined);
  mockResolveTenantByApiKeyId.mockResolvedValue(undefined);

  const result = await handler(eventWith("key-huerfana", VALID_BODY));

  expect(result.statusCode).toBe(403);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("tenant bloqueado (resuelto por api-key de agente): 403, no llega a S3 ni DynamoDB", async () => {
  mockResolveAgentByApiKeyId.mockResolvedValue({ tenantId: "t-agente", agentId: "a1", name: "Robot 1", apiKeyId: "agent-key-1", createdAt: "2026-01-01T00:00:00.000Z" });
  mockGetTenant.mockResolvedValue({ status: "blocked" });

  const result = await handler(eventWith("agent-key-1", VALID_BODY));

  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body).error).toContain("bloqueado");
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("tenant bloqueado (resuelto por api-key compartida del tenant): 403", async () => {
  mockResolveTenantByApiKeyId.mockResolvedValue({ ...validTenant, status: "blocked" });

  const result = await handler(eventWith("key1", VALID_BODY));

  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body).error).toContain("bloqueado");
  expect(mockS3Send).not.toHaveBeenCalled();
});
