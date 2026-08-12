import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, ASSISTANT_USAGE_TABLE: "TestAssistantUsage" };
});

import { checkAssistantRateLimit } from "../../src/assistant/rateLimit";

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("dentro de los límites: dos escrituras condicionales (minuto + día), ok", async () => {
  mockDdbSend.mockResolvedValue({});

  const result = await checkAssistantRateLimit("t1");

  expect(result).toEqual({ ok: true });
  expect(mockDdbSend).toHaveBeenCalledTimes(2);

  const [minuteCall, dayCall] = mockDdbSend.mock.calls.map(([cmd]) => cmd.input);
  expect(minuteCall.Key.pk).toMatch(/^TENANT#t1#WINDOW#MIN#\d+$/);
  expect(dayCall.Key.pk).toMatch(/^TENANT#t1#WINDOW#DAY#\d{4}-\d{2}-\d{2}$/);
  // Condición evaluada ANTES del incremento — dos requests simultáneos no
  // pueden colarse los dos por encima del límite.
  expect(minuteCall.ConditionExpression).toContain("#count < :limit");
});

test("supera el límite por minuto: no llega a escribir la ventana diaria", async () => {
  mockDdbSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));

  const result = await checkAssistantRateLimit("t1");

  expect(result).toEqual({ ok: false, reason: "minute" });
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
});

test("pasa el límite por minuto pero supera el diario", async () => {
  mockDdbSend
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));

  const result = await checkAssistantRateLimit("t1");

  expect(result).toEqual({ ok: false, reason: "day" });
  expect(mockDdbSend).toHaveBeenCalledTimes(2);
});

test("un error de DynamoDB que no es de condición se propaga (no se confunde con rate limit)", async () => {
  mockDdbSend.mockRejectedValue(new Error("DynamoDB no disponible"));

  await expect(checkAssistantRateLimit("t1")).rejects.toThrow("DynamoDB no disponible");
});

test("tenants distintos usan buckets independientes", async () => {
  mockDdbSend.mockResolvedValue({});

  await checkAssistantRateLimit("tenant-a");
  await checkAssistantRateLimit("tenant-b");

  const keys = mockDdbSend.mock.calls.map(([cmd]) => cmd.input.Key.pk as string);
  expect(keys.some((k) => k.startsWith("TENANT#tenant-a#"))).toBe(true);
  expect(keys.some((k) => k.startsWith("TENANT#tenant-b#"))).toBe(true);
});
