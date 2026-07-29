import { readFileSync } from "node:fs";
import { join } from "node:path";

import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockGetTenant = jest.fn();
const mockBedrockSend = jest.fn();

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
  getTenant: (...args: unknown[]) => mockGetTenant(...args),
}));

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockS3Send(...args) })),
  };
});

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const actual = jest.requireActual("@aws-sdk/client-bedrock-runtime");
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockBedrockSend(...args) })),
  };
});

function bedrockTextResponse(text: string) {
  return { output: { message: { content: [{ text }] } } };
}

import { handler } from "../../src/parser/handler";

const VALID_TICKET_TEXT = readFileSync(
  join(process.cwd(), "fixtures", "sample-tickets", "01-item-unico.txt"),
  "utf-8",
);

function streamRecord(eventName: "INSERT" | "MODIFY" | "REMOVE", newImage?: Record<string, unknown>): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: "seq-1",
      NewImage: newImage ? (marshall(newImage) as never) : undefined,
    },
  } as DynamoDBRecord;
}

function pendingTicket(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "t1",
    ticketId: "tk1",
    port: "COM3",
    capturedAt: "2026-07-27T12:00:00.000Z",
    status: "pending",
    rawS3Key: "tenants/t1/tk1.txt",
    ...overrides,
  };
}

const validTenant = {
  tenantId: "t1",
  businessName: "Negocio de prueba",
  parserId: "example-38col",
  portParsers: {},
  apiKeyId: "key1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  mockDdbSend.mockReset();
  mockS3Send.mockReset();
  mockGetTenant.mockReset();
  mockBedrockSend.mockReset();
  delete process.env.BEDROCK_MODEL_ID;
});

test("INSERT + pending + texto válido: parsea y actualiza a parsed", async () => {
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => VALID_TICKET_TEXT } });
  mockDdbSend.mockResolvedValue({});

  const result = await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(result.batchItemFailures).toEqual([]);
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("parsed");
  expect(update.ExpressionAttributeValues[":total"]).toBe(3450);
  expect(update.ExpressionAttributeValues[":parsedBy"]).toBe("deterministic");
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("tenant inexistente: marca failed sin tocar S3", async () => {
  mockGetTenant.mockResolvedValue(undefined);
  mockDdbSend.mockResolvedValue({});

  const result = await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(result.batchItemFailures).toEqual([]);
  expect(mockS3Send).not.toHaveBeenCalled();
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/tenant no encontrado/);
});

test("parserId desconocido: marca failed sin tocar S3", async () => {
  mockGetTenant.mockResolvedValue({ ...validTenant, parserId: "parser-que-no-existe" });
  mockDdbSend.mockResolvedValue({});

  const result = await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(mockS3Send).not.toHaveBeenCalled();
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/parser desconocido/);
});

test("texto que el parser no reconoce, sin BEDROCK_MODEL_ID: marca failed sin llamar a Bedrock", async () => {
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => "esto no es un ticket" } });
  mockDdbSend.mockResolvedValue({});

  await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(mockBedrockSend).not.toHaveBeenCalled();
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/no pudo extraer/);
});

test("texto que el parser no reconoce, pero Bedrock extrae un ticket válido: marca needs_review", async () => {
  process.env.BEDROCK_MODEL_ID = "test-model";
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => "algo raro que el regex no reconoce" } });
  mockBedrockSend.mockResolvedValue(
    bedrockTextResponse(
      JSON.stringify({
        items: [{ description: "Café", quantity: 1, unitPrice: 900, subtotal: 900, voided: false }],
        total: 900,
        discount: null,
        tip: null,
        timestamp: "2026-07-29T20:42:00.000Z",
      }),
    ),
  );
  mockDdbSend.mockResolvedValue({});

  const result = await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(result.batchItemFailures).toEqual([]);
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("needs_review");
  expect(update.ExpressionAttributeValues[":total"]).toBe(900);
  expect(update.ExpressionAttributeValues[":parsedBy"]).toBe("bedrock-fallback");
});

test("ni el parser ni Bedrock (fallback activo) reconocen el texto: marca failed con el mensaje combinado", async () => {
  process.env.BEDROCK_MODEL_ID = "test-model";
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => "esto no es un ticket ni para el LLM" } });
  mockBedrockSend.mockResolvedValue(bedrockTextResponse(JSON.stringify({ unparseable: true })));
  mockDdbSend.mockResolvedValue({});

  await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/ni el parser .* ni el fallback de Bedrock/);
});

test("Bedrock tira un error transitorio (ej. throttling): se reporta como batch item failure, no marca failed", async () => {
  process.env.BEDROCK_MODEL_ID = "test-model";
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => "esto no es un ticket" } });
  mockBedrockSend.mockRejectedValue(new Error("ThrottlingException"));

  const result = await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(result.batchItemFailures).toEqual([{ itemIdentifier: "seq-1" }]);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

// Texto que el parser determinístico SÍ reconoce (matchea items + TOTAL:),
// pero con un total que no coincide con la suma de los ítems — ninguno de
// los dos parsers verifica esto por su cuenta, así que sin el chequeo de
// coherencia esto se aceptaría igual como "parsed" con un total inventado.
const INCOHERENT_DETERMINISTIC_TEXT = `CANT  DESCRIPCION         P.UNIT  SUBTOT
  1   Combo Milanesa       3450     3450
                       TOTAL:   $9999,00`;

test("el parser determinístico extrae un total que no coincide con los ítems: sin Bedrock, marca failed por incoherencia", async () => {
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => INCOHERENT_DETERMINISTIC_TEXT } });
  mockDdbSend.mockResolvedValue({});

  await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(mockBedrockSend).not.toHaveBeenCalled();
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/no es económicamente coherente/);
});

test("el determinístico da un resultado incoherente, pero Bedrock rescata uno coherente: marca needs_review", async () => {
  process.env.BEDROCK_MODEL_ID = "test-model";
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => INCOHERENT_DETERMINISTIC_TEXT } });
  mockBedrockSend.mockResolvedValue(
    bedrockTextResponse(
      JSON.stringify({
        items: [{ description: "Combo Milanesa", quantity: 1, unitPrice: 3450, subtotal: 3450, voided: false }],
        total: 3450,
        discount: null,
        tip: null,
        timestamp: "2026-07-19T13:24:00.000Z",
      }),
    ),
  );
  mockDdbSend.mockResolvedValue({});

  await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("needs_review");
  expect(update.ExpressionAttributeValues[":total"]).toBe(3450);
  expect(update.ExpressionAttributeValues[":parsedBy"]).toBe("bedrock-fallback");
});

test("Bedrock (fallback activo) devuelve un resultado incoherente: marca failed mencionando la incoherencia", async () => {
  process.env.BEDROCK_MODEL_ID = "test-model";
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => "esto no es un ticket" } });
  mockBedrockSend.mockResolvedValue(
    bedrockTextResponse(
      JSON.stringify({
        items: [{ description: "Algo", quantity: 1, unitPrice: 100, subtotal: 100, voided: false }],
        total: 99999,
        discount: null,
        tip: null,
        timestamp: null,
      }),
    ),
  );
  mockDdbSend.mockResolvedValue({});

  await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/no es económicamente coherente/);
});

test("Bedrock devuelve un descuento negativo: nunca guarda el ticket como parsed", async () => {
  process.env.BEDROCK_MODEL_ID = "test-model";
  mockGetTenant.mockResolvedValue(validTenant);
  mockS3Send.mockResolvedValue({ Body: { transformToString: async () => "ticket con formato desconocido" } });
  mockBedrockSend.mockResolvedValue(
    bedrockTextResponse(
      JSON.stringify({
        items: [{ description: "Café", quantity: 1, unitPrice: 900, subtotal: 900, voided: false }],
        total: 1000,
        discount: -100,
        tip: null,
        timestamp: "2026-07-29T20:42:00.000Z",
      }),
    ),
  );
  mockDdbSend.mockResolvedValue({});

  await handler({ Records: [streamRecord("INSERT", pendingTicket())] });

  const update = mockDdbSend.mock.calls[0][0].input;
  expect(update.ExpressionAttributeValues[":status"]).toBe("failed");
  expect(update.ExpressionAttributeValues[":reason"]).toMatch(/no es económicamente coherente/);
});

// Este es exactamente el fix de la migración a Streams: un MODIFY (ej.
// cuando este mismo Lambda actualiza el ticket a parsed/failed) no debe
// volver a dispararse a sí mismo — sin esto, cada resultado de parseo
// generaría un nuevo evento de stream y el Lambda se llamaría en bucle.
test("MODIFY no se procesa (evita que el propio update se dispare a sí mismo)", async () => {
  const result = await handler({ Records: [streamRecord("MODIFY", pendingTicket())] });

  expect(result.batchItemFailures).toEqual([]);
  expect(mockGetTenant).not.toHaveBeenCalled();
  expect(mockDdbSend).not.toHaveBeenCalled();
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("un ticket que ya no está pending (parsed/failed) no se reprocesa", async () => {
  const result = await handler({ Records: [streamRecord("INSERT", pendingTicket({ status: "parsed" }))] });

  expect(result.batchItemFailures).toEqual([]);
  expect(mockGetTenant).not.toHaveBeenCalled();
});

test("un error transitorio (ej. DynamoDB caído) se reporta como batch item failure, no tira el batch entero", async () => {
  mockGetTenant.mockRejectedValue(new Error("DynamoDB no responde"));

  const result = await handler({
    Records: [streamRecord("INSERT", pendingTicket({ ticketId: "tk-fail" })), streamRecord("MODIFY")],
  });

  expect(result.batchItemFailures).toEqual([{ itemIdentifier: "seq-1" }]);
});
