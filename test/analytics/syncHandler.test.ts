import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets", ANALYTICS_BUCKET: "test-analytics" };
});

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockS3Send(...args) })) };
});

import { handler } from "../../src/analytics/syncHandler";

const CAPTURED_AT = "2026-10-05T15:00:00.000Z";
const SK = `TICKET#${CAPTURED_AT}#tk1`;

function record(sk: string, seq = "1", eventName: "INSERT" | "MODIFY" | "REMOVE" = "MODIFY"): DynamoDBRecord {
  return {
    eventName,
    dynamodb: { SequenceNumber: seq, Keys: { pk: { S: "TENANT#t1" }, sk: { S: sk } } },
  } as DynamoDBRecord;
}

const run = (...records: DynamoDBRecord[]) => handler({ Records: records } as DynamoDBStreamEvent);

const storedTicket = (overrides: Record<string, unknown> = {}) => ({
  tenantId: "t1", ticketId: "tk1", capturedAt: CAPTURED_AT, port: "COM3", status: "parsed", parsedBy: "deterministic",
  items: [{ description: "Café", quantity: 1, unitPrice: 10, subtotal: 10 }], total: 10, ...overrides,
});

const s3Inputs = () => mockS3Send.mock.calls.map((c) => ({ type: c[0].constructor.name, ...c[0].input }));

beforeEach(() => {
  mockDdbSend.mockReset();
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({});
});

test("ticket que cuenta: lee el estado vigente (consistente) y escribe su objeto", async () => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket() });

  const result = await run(record(SK));

  expect(result.batchItemFailures).toEqual([]);
  expect(mockDdbSend.mock.calls[0][0].input).toMatchObject({ TableName: "TestTickets", Key: { pk: "TENANT#t1", sk: SK }, ConsistentRead: true });
  const [put] = s3Inputs();
  expect(put.type).toBe("PutObjectCommand");
  expect(put.Bucket).toBe("test-analytics");
  expect(put.Key).toBe("tenant=t1/year=2026/month=10/tk1.jsonl");
  expect(JSON.parse(put.Body.trim()).status).toBe("parsed");
});

test("needs_review también se escribe", async () => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket({ status: "needs_review", parsedBy: "bedrock-vision" }) });
  await run(record(SK));
  const [put] = s3Inputs();
  expect(put.type).toBe("PutObjectCommand");
  expect(JSON.parse(put.Body.trim()).status).toBe("needs_review");
});

test.each(["discarded", "failed", "pending"])("ticket %s: borra su objeto, no lo escribe", async (status) => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket({ status }) });
  await run(record(SK));
  expect(s3Inputs()).toEqual([expect.objectContaining({ type: "DeleteObjectCommand", Key: "tenant=t1/year=2026/month=10/tk1.jsonl" })]);
});

test("un evento viejo no restaura datos desactualizados: manda el estado vigente, no el del evento", async () => {
  // El evento (MODIFY) vio el ticket en needs_review, pero hoy está descartado.
  const stale = { ...record(SK), dynamodb: { ...record(SK).dynamodb, NewImage: { status: { S: "needs_review" } } } } as DynamoDBRecord;
  mockDdbSend.mockResolvedValue({ Item: storedTicket({ status: "discarded" }) });

  await run(stale);

  expect(s3Inputs().map((c) => c.type)).toEqual(["DeleteObjectCommand"]);
});

test("el mismo evento dos veces deja el mismo resultado: misma clave y mismo cuerpo", async () => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket() });

  await run(record(SK, "1"));
  await run(record(SK, "1"));

  const [first, second] = s3Inputs();
  expect(second.Key).toBe(first.Key);
  expect(second.Body).toBe(first.Body);
});

test("ticket que ya no existe (REMOVE): borra el objeto", async () => {
  mockDdbSend.mockResolvedValue({});
  await run(record(SK, "1", "REMOVE"));
  expect(s3Inputs().map((c) => c.type)).toEqual(["DeleteObjectCommand"]);
});

test("ticket sin ítems: no hay filas que contar, se borra el objeto", async () => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket({ items: [] }) });
  await run(record(SK));
  expect(s3Inputs().map((c) => c.type)).toEqual(["DeleteObjectCommand"]);
});

test("marcadores DEDUP# y claves ajenas se ignoran sin tocar DynamoDB ni S3", async () => {
  await run(record("DEDUP#abc123"), { eventName: "INSERT", dynamodb: { SequenceNumber: "9" } } as DynamoDBRecord);
  expect(mockDdbSend).not.toHaveBeenCalled();
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("falla la escritura analítica: el registro se reporta para reintento y el resto del batch sigue", async () => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket() });
  mockS3Send.mockRejectedValueOnce(new Error("S3 no responde")).mockResolvedValue({});

  const result = await run(record(SK, "seq-1"), record(`TICKET#${CAPTURED_AT}#tk2`, "seq-2"));

  expect(result.batchItemFailures).toEqual([{ itemIdentifier: "seq-1" }]);
  expect(mockS3Send).toHaveBeenCalledTimes(2); // el segundo registro se procesó igual
});

test("falla la lectura de DynamoDB: se reporta para reintento y no se escribe nada", async () => {
  mockDdbSend.mockRejectedValue(new Error("throttling"));
  const result = await run(record(SK, "seq-1"));
  expect(result.batchItemFailures).toEqual([{ itemIdentifier: "seq-1" }]);
  expect(mockS3Send).not.toHaveBeenCalled();
});

test("tras un fallo, el reintento recupera la venta sin duplicarla", async () => {
  mockDdbSend.mockResolvedValue({ Item: storedTicket() });
  mockS3Send.mockRejectedValueOnce(new Error("S3 no responde")).mockResolvedValue({});

  expect((await run(record(SK, "seq-1"))).batchItemFailures).toHaveLength(1);
  expect((await run(record(SK, "seq-1"))).batchItemFailures).toEqual([]);

  const puts = s3Inputs().filter((c) => c.type === "PutObjectCommand");
  expect(new Set(puts.map((p) => p.Key)).size).toBe(1); // misma clave: un solo objeto en S3
});
