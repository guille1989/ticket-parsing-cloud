import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets", RAW_BUCKET: "test-raw" };
});

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockS3Send(...args) })) };
});

import { handler } from "../../src/image/handler";

const TICKET_ID = "5f2b9c3a-1111-4444-8888-abcdefabcdef";
const CAPTURED_AT = "2026-09-14T22:56:42.633Z";

function event(query: Record<string, string> | undefined, tenantId = "t1", ticketId = TICKET_ID): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    pathParameters: { ticketId },
    queryStringParameters: query,
    requestContext: { authorizer: { claims: { "custom:tenantId": tenantId } } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

/** `GS v 0` con una franja raster de `widthBytes*8` × `height`, toda en negro — misma fixture que escpos.test.ts. */
function rasterStream(widthBytes: number, height: number): Buffer {
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, height & 0xff, height >> 8]);
  return Buffer.concat([Buffer.from([0x1b, 0x40]), header, Buffer.alloc(widthBytes * height, 0xff), Buffer.from([0x1d, 0x56, 0x00])]);
}

function s3Body(bytes: Buffer) {
  return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockS3Send.mockReset();
});

test("sin claim de tenant: 403, no toca DynamoDB ni S3", async () => {
  const result = await handler(event({ capturedAt: CAPTURED_AT }, ""));
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("falta ticketId en el path: 400", async () => {
  const e = event({ capturedAt: CAPTURED_AT });
  e.pathParameters = {};
  const result = await handler(e);
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("falta capturedAt en el query string: 400", async () => {
  const result = await handler(event(undefined));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("ticket no encontrado: 404", async () => {
  mockDdbSend.mockResolvedValue({ Item: undefined });
  const result = await handler(event({ capturedAt: CAPTURED_AT }));
  expect(result.statusCode).toBe(404);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("ticket de texto (rawKind !== escpos): 404, no baja nada de S3", async () => {
  mockDdbSend.mockResolvedValue({ Item: { rawKind: "text", rawS3Key: "k1" } });
  const result = await handler(event({ capturedAt: CAPTURED_AT }));
  expect(result.statusCode).toBe(404);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("ESC/POS mayormente texto (no raster dominante): 404, aunque sí consulta S3", async () => {
  mockDdbSend.mockResolvedValue({ Item: { rawKind: "escpos", rawS3Key: "k1" } });
  mockS3Send.mockResolvedValue(s3Body(Buffer.from("Empanada de Pollo x1 $4600\n".repeat(5), "latin1")));
  const result = await handler(event({ capturedAt: CAPTURED_AT }));
  expect(result.statusCode).toBe(404);
  expect(mockS3Send).toHaveBeenCalledTimes(1);
});

test("ticket-imagen raster: 200 con el PNG reconstruido en base64", async () => {
  mockDdbSend.mockResolvedValue({ Item: { rawKind: "escpos", rawS3Key: "k1" } });
  mockS3Send.mockResolvedValue(s3Body(rasterStream(72, 8))); // 576 bytes de raster, sobre el piso de looksRasterDominant

  const result = await handler(event({ capturedAt: CAPTURED_AT }));

  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.ticketId).toBe(TICKET_ID);
  expect(body.width).toBeGreaterThan(0);
  expect(body.height).toBe(8);
  expect(body.png).toMatch(/^data:image\/png;base64,/);

  const getInput = mockDdbSend.mock.calls[0][0].input;
  expect(getInput.Key).toEqual({ pk: "TENANT#t1", sk: `TICKET#${CAPTURED_AT}#${TICKET_ID}` });
  const s3Input = mockS3Send.mock.calls[0][0].input;
  expect(s3Input).toEqual({ Bucket: "test-raw", Key: "k1" });
});
