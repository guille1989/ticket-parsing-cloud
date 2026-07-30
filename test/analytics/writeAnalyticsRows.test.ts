const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockS3Send(...args) })),
  };
});

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { writeAnalyticsRows } from "../../src/analytics/writeAnalyticsRows";
import type { ParsedTicket } from "../../src/parsing/types";

const ctx = {
  tenantId: "t1",
  ticketId: "tk1",
  capturedAt: "2026-07-29T20:42:00.000Z",
  port: "COM3",
  parsedBy: "deterministic" as const,
  status: "parsed" as const,
};

function ticket(overrides: Partial<ParsedTicket> = {}): ParsedTicket {
  return {
    items: [{ description: "Café", quantity: 2, unitPrice: 900, subtotal: 1800, voided: false }],
    total: 1800,
    timestamp: "2026-07-29T20:42:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({});
});

test("escribe la key particionada por tenant/año/mes/día", async () => {
  await writeAnalyticsRows("analytics-bucket", ctx, ticket());

  const call = mockS3Send.mock.calls[0][0] as PutObjectCommand;
  expect(call).toBeInstanceOf(PutObjectCommand);
  expect(call.input.Bucket).toBe("analytics-bucket");
  expect(call.input.Key).toBe("tenant=t1/year=2026/month=07/day=29/tk1.jsonl");
});

test("una fila por ítem, con los datos del ticket denormalizados en cada una", async () => {
  await writeAnalyticsRows(
    "analytics-bucket",
    ctx,
    ticket({
      items: [
        { description: "Café", quantity: 2, unitPrice: 900, subtotal: 1800, voided: false },
        { description: "Medialuna", quantity: 1, unitPrice: 500, subtotal: 500, voided: false },
      ],
      discount: 100,
      tip: 50,
      total: 2250,
    }),
  );

  const call = mockS3Send.mock.calls[0][0] as PutObjectCommand;
  const lines = (call.input.Body as string).trim().split("\n");
  expect(lines).toHaveLength(2);

  const row1 = JSON.parse(lines[0]);
  expect(row1).toMatchObject({
    tenantId: "t1",
    ticketId: "tk1",
    port: "COM3",
    status: "parsed",
    parsedBy: "deterministic",
    description: "Café",
    quantity: 2,
    unitPrice: 900,
    subtotal: 1800,
    voided: false,
    discount: 100,
    tip: 50,
    total: 2250,
  });

  const row2 = JSON.parse(lines[1]);
  expect(row2.description).toBe("Medialuna");
  expect(row2.subtotal).toBe(500);
});

test("discount/tip ausentes se escriben como null, no undefined (evita romper el SerDe de Athena)", async () => {
  await writeAnalyticsRows("analytics-bucket", ctx, ticket());

  const call = mockS3Send.mock.calls[0][0] as PutObjectCommand;
  const row = JSON.parse((call.input.Body as string).trim());
  expect(row.discount).toBeNull();
  expect(row.tip).toBeNull();
});
