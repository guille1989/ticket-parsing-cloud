const mockBedrockSend = jest.fn();

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const actual = jest.requireActual("@aws-sdk/client-bedrock-runtime");
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockBedrockSend(...args) })),
  };
});

import { tryBedrockVision } from "../../src/parsing/bedrockVision";

function bedrockTextResponse(text: string) {
  return { output: { message: { content: [{ text }] } } };
}

function validTicketJson() {
  return JSON.stringify({
    items: [{ description: "H2O PET 600ML", quantity: 1, unitPrice: 6100, subtotal: 6100, voided: false }],
    total: 6100,
    discount: null,
    tip: null,
    timestamp: "2026-09-09T10:16:24.000Z",
  });
}

function throttlingError() {
  const err = new Error("Too many requests");
  err.name = "ThrottlingException";
  return err;
}

const tiles = [Buffer.from("PNG-franja-1"), Buffer.from("PNG-franja-2")];

beforeEach(() => mockBedrockSend.mockReset());

test("sin franjas: devuelve null sin llamar a Bedrock", async () => {
  const result = await tryBedrockVision([], "test-model");
  expect(result).toBeNull();
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("manda cada franja como un bloque de imagen PNG y devuelve el ticket", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockResolvedValue(bedrockTextResponse(validTicketJson()));

  const result = await tryBedrockVision(tiles, "test-model", wait);

  expect(result).toEqual(
    expect.objectContaining({ total: 6100, items: [expect.objectContaining({ description: "H2O PET 600ML" })] }),
  );
  const content = mockBedrockSend.mock.calls[0][0].input.messages[0].content;
  const images = content.filter((b: Record<string, unknown>) => "image" in b);
  expect(images).toHaveLength(2);
  expect(images[0].image.format).toBe("png");
  expect(images[0].image.source.bytes).toBe(tiles[0]);
});

test("throttling una vez y después éxito: reintenta con backoff", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockRejectedValueOnce(throttlingError()).mockResolvedValueOnce(bedrockTextResponse(validTicketJson()));

  const result = await tryBedrockVision(tiles, "test-model", wait);

  expect(result).not.toBeNull();
  expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledWith(1000);
});

test("el modelo responde unparseable: devuelve null sin reintentar", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockResolvedValue(bedrockTextResponse(JSON.stringify({ unparseable: true })));

  const result = await tryBedrockVision(tiles, "test-model", wait);

  expect(result).toBeNull();
  expect(wait).not.toHaveBeenCalled();
});

test("un error que no es throttling se propaga", async () => {
  mockBedrockSend.mockRejectedValue(new Error("boom"));
  await expect(tryBedrockVision(tiles, "test-model")).rejects.toThrow("boom");
});

test("nunca manda más de 12 franjas", async () => {
  mockBedrockSend.mockResolvedValue(bedrockTextResponse(validTicketJson()));
  const many = Array.from({ length: 20 }, (_, i) => Buffer.from(`franja-${i}`));

  await tryBedrockVision(many, "test-model", jest.fn().mockResolvedValue(undefined));

  const content = mockBedrockSend.mock.calls[0][0].input.messages[0].content;
  expect(content.filter((b: Record<string, unknown>) => "image" in b)).toHaveLength(12);
});
