import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, SIGNUP_USAGE_TABLE: "TestSignupUsage" };
});

import { checkSignupRateLimit } from "../../src/signup/rateLimit";

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("dentro del límite: una escritura condicional, ok", async () => {
  mockDdbSend.mockResolvedValue({});

  const result = await checkSignupRateLimit("1.2.3.4");

  expect(result).toEqual({ ok: true });
  expect(mockDdbSend).toHaveBeenCalledTimes(1);
  const input = mockDdbSend.mock.calls[0][0].input;
  expect(input.TableName).toBe("TestSignupUsage");
  expect(input.Key.pk).toMatch(/^IP#1\.2\.3\.4#WINDOW#HOUR#\d+$/);
});

test("supera el límite por hora", async () => {
  mockDdbSend.mockRejectedValue(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));

  const result = await checkSignupRateLimit("1.2.3.4");

  expect(result).toEqual({ ok: false });
});

test("IPs distintas usan buckets independientes", async () => {
  mockDdbSend.mockResolvedValue({});

  await checkSignupRateLimit("1.1.1.1");
  await checkSignupRateLimit("2.2.2.2");

  const keys = mockDdbSend.mock.calls.map(([cmd]) => cmd.input.Key.pk as string);
  expect(keys[0]).toContain("IP#1.1.1.1#");
  expect(keys[1]).toContain("IP#2.2.2.2#");
});
