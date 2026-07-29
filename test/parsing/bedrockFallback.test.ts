const mockBedrockSend = jest.fn();

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const actual = jest.requireActual("@aws-sdk/client-bedrock-runtime");
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockBedrockSend(...args) })),
  };
});

import { tryBedrockFallback } from "../../src/parsing/bedrockFallback";

function bedrockTextResponse(text: string) {
  return { output: { message: { content: [{ text }] } } };
}

function validTicketJson() {
  return JSON.stringify({
    items: [{ description: "Medialuna", quantity: 2, unitPrice: 900, subtotal: 1800, voided: false }],
    total: 1800,
    discount: null,
    tip: null,
    timestamp: "2026-07-29T20:00:00.000Z",
  });
}

function throttlingError() {
  const err = new Error("Too many requests");
  err.name = "ThrottlingException";
  return err;
}

function marketplaceAccessDeniedError() {
  const err = new Error(
    "Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)",
  );
  err.name = "AccessDeniedException";
  return err;
}

function unrelatedAccessDeniedError() {
  const err = new Error("User is not authorized to perform this action");
  err.name = "AccessDeniedException";
  return err;
}

beforeEach(() => {
  mockBedrockSend.mockReset();
});

test("éxito al primer intento: no espera nada", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockResolvedValue(bedrockTextResponse(validTicketJson()));

  const result = await tryBedrockFallback("texto raro", "test-model", wait);

  expect(result).toEqual(
    expect.objectContaining({ total: 1800, items: [expect.objectContaining({ description: "Medialuna" })] }),
  );
  expect(wait).not.toHaveBeenCalled();
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
});

test("throttling una vez y después éxito: reintenta con backoff y devuelve el ticket", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockRejectedValueOnce(throttlingError()).mockResolvedValueOnce(bedrockTextResponse(validTicketJson()));

  const result = await tryBedrockFallback("texto raro", "test-model", wait);

  expect(result).not.toBeNull();
  expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledTimes(1);
  expect(wait).toHaveBeenCalledWith(1000);
});

test("el AccessDeniedException de cuota de Marketplace se reintenta igual que un throttling normal", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend
    .mockRejectedValueOnce(marketplaceAccessDeniedError())
    .mockResolvedValueOnce(bedrockTextResponse(validTicketJson()));

  const result = await tryBedrockFallback("texto raro", "test-model", wait);

  expect(result).not.toBeNull();
  expect(wait).toHaveBeenCalledTimes(1);
});

test("throttling persistente agota los 3 intentos y termina propagando el error", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockRejectedValue(throttlingError());

  await expect(tryBedrockFallback("texto raro", "test-model", wait)).rejects.toThrow("Too many requests");

  expect(mockBedrockSend).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenNthCalledWith(1, 1000);
  expect(wait).toHaveBeenNthCalledWith(2, 2000);
});

test("un AccessDeniedException que NO es de cuota (permiso real) no se reintenta, se propaga directo", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockRejectedValue(unrelatedAccessDeniedError());

  await expect(tryBedrockFallback("texto raro", "test-model", wait)).rejects.toThrow(
    "User is not authorized to perform this action",
  );

  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

test("el modelo responde unparseable: devuelve null sin reintentar", async () => {
  const wait = jest.fn().mockResolvedValue(undefined);
  mockBedrockSend.mockResolvedValue(bedrockTextResponse(JSON.stringify({ unparseable: true })));

  const result = await tryBedrockFallback("esto no es un ticket", "test-model", wait);

  expect(result).toBeNull();
  expect(wait).not.toHaveBeenCalled();
});
