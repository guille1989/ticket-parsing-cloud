import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { handler as HandlerType, validateBody as ValidateBodyType } from "../../src/agents/activateHandler";

const mockDdbSend = jest.fn();
const mockApigwSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return {
    ...actual,
    ddb: { send: (...args: unknown[]) => mockDdbSend(...args) },
    AGENTS_TABLE: "TestAgents",
    ACTIVATION_CODES_TABLE: "TestActivationCodes",
  };
});

jest.mock("@aws-sdk/client-api-gateway", () => {
  const actual = jest.requireActual("@aws-sdk/client-api-gateway");
  return {
    ...actual,
    APIGatewayClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockApigwSend(...args) })),
  };
});

const VALID_CODE = "ABCDE-FGHJK";

function eventWith(body: unknown): APIGatewayProxyEvent {
  return { body: body === undefined ? null : JSON.stringify(body) } as unknown as APIGatewayProxyEvent;
}

// `resolveUsagePlanId()` en el handler cachea el id a nivel de módulo (así
// un Lambda "tibio" no lo vuelve a buscar en cada invocación) — sin
// `resetModules` esa cache sobreviviría entre tests y correría el orden de
// llamadas mockeadas de los tests siguientes.
let handler: typeof HandlerType;
let validateBody: typeof ValidateBodyType;

beforeEach(() => {
  jest.resetModules();
  mockDdbSend.mockReset();
  mockApigwSend.mockReset();
  process.env.USAGE_PLAN_NAME = "test-plan-name";
  ({ handler, validateBody } = require("../../src/agents/activateHandler"));
});

describe("validateBody", () => {
  test("rechaza un código con formato inválido", () => {
    expect(validateBody({ code: "no-es-un-codigo" })).toEqual({ ok: false, error: expect.any(String) });
  });

  test("rechaza name vacío", () => {
    expect(validateBody({ code: VALID_CODE, name: "   " })).toEqual({ ok: false, error: expect.any(String) });
  });

  test("acepta un código válido sin name", () => {
    expect(validateBody({ code: VALID_CODE })).toEqual({ ok: true, value: { code: VALID_CODE, name: undefined } });
  });
});

test("body que no es JSON válido: 400", async () => {
  const event = { body: "{esto no es json" } as unknown as APIGatewayProxyEvent;
  const result = await handler(event);
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("code con formato inválido: 400, no toca DynamoDB", async () => {
  const result = await handler(eventWith({ code: "xxxxx" }));
  expect(result.statusCode).toBe(400);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("código ya usado o inexistente (ConditionalCheckFailedException): 403 genérico", async () => {
  mockDdbSend.mockRejectedValue(new ConditionalCheckFailedException({ message: "ya usado", $metadata: {} }));

  const result = await handler(eventWith({ code: VALID_CODE }));

  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body).error).toBe("código inválido o ya usado");
  expect(mockApigwSend).not.toHaveBeenCalled();
});

test("un error de DynamoDB que NO es de condición se propaga", async () => {
  mockDdbSend.mockRejectedValue(new Error("DynamoDB no disponible"));
  await expect(handler(eventWith({ code: VALID_CODE }))).rejects.toThrow("DynamoDB no disponible");
});

test("canje exitoso: reclama el código, mintea api-key, crea el agente, responde 201", async () => {
  // 1er ddb.send: UpdateCommand que reclama el código (ReturnValues ALL_NEW)
  mockDdbSend.mockResolvedValueOnce({ Attributes: { tenantId: "t1", code: VALID_CODE, status: "used" } });
  mockApigwSend
    .mockResolvedValueOnce({ id: "apikey-1", value: "secret-value-1" }) // CreateApiKeyCommand
    .mockResolvedValueOnce({ items: [{ id: "resolved-plan-id", name: "test-plan-name" }] }) // GetUsagePlansCommand
    .mockResolvedValueOnce({}); // CreateUsagePlanKeyCommand
  // 2do ddb.send: PutCommand del registro de Agent
  mockDdbSend.mockResolvedValueOnce({});
  // 3er ddb.send: UpdateCommand best-effort anotando agentId en el código
  mockDdbSend.mockResolvedValueOnce({});

  const result = await handler(eventWith({ code: VALID_CODE, name: "Caja 1" }));

  expect(result.statusCode).toBe(201);
  const body = JSON.parse(result.body);
  expect(body.name).toBe("Caja 1");
  expect(body.apiKey).toBe("secret-value-1");
  expect(typeof body.agentId).toBe("string");

  // La api-key nueva se asocia al usage plan del negocio (resuelto por
  // nombre, no por el id que le pasa CDK — ver comentario en el handler),
  // no se descarta.
  const usagePlanCall = mockApigwSend.mock.calls[2][0].input;
  expect(usagePlanCall.usagePlanId).toBe("resolved-plan-id");
  expect(usagePlanCall.keyId).toBe("apikey-1");

  const putAgentCall = mockDdbSend.mock.calls[1][0].input;
  expect(putAgentCall.TableName).toBe("TestAgents");
  expect(putAgentCall.Item.tenantId).toBe("t1");
  expect(putAgentCall.Item.apiKeyId).toBe("apikey-1");
  expect(putAgentCall.Item.name).toBe("Caja 1");
});

test("sin name: genera uno por default a partir del agentId", async () => {
  mockDdbSend.mockResolvedValueOnce({ Attributes: { tenantId: "t1" } });
  mockApigwSend
    .mockResolvedValueOnce({ id: "apikey-1", value: "secret" })
    .mockResolvedValueOnce({ items: [{ id: "resolved-plan-id", name: "test-plan-name" }] })
    .mockResolvedValueOnce({});
  mockDdbSend.mockResolvedValueOnce({});
  mockDdbSend.mockResolvedValueOnce({});

  const result = await handler(eventWith({ code: VALID_CODE }));

  const body = JSON.parse(result.body);
  expect(body.name).toMatch(/^Robot /);
});

test("si el minteo de la api-key no devuelve id/value: falla en vez de crear un agente sin credencial", async () => {
  mockDdbSend.mockResolvedValueOnce({ Attributes: { tenantId: "t1" } });
  mockApigwSend.mockResolvedValueOnce({}); // sin id ni value

  await expect(handler(eventWith({ code: VALID_CODE }))).rejects.toThrow();
});

test("si no existe ningún usage plan con ese nombre: falla en vez de mintear una key huérfana", async () => {
  mockDdbSend.mockResolvedValueOnce({ Attributes: { tenantId: "t1" } });
  mockApigwSend
    .mockResolvedValueOnce({ id: "apikey-1", value: "secret" })
    .mockResolvedValueOnce({ items: [{ id: "otro-plan", name: "nombre-que-no-matchea" }] });

  await expect(handler(eventWith({ code: VALID_CODE }))).rejects.toThrow(/usage plan/);
});

test("si falla el update best-effort de agentId en el código, el canje igual responde 201", async () => {
  mockDdbSend.mockResolvedValueOnce({ Attributes: { tenantId: "t1" } });
  mockApigwSend
    .mockResolvedValueOnce({ id: "apikey-1", value: "secret" })
    .mockResolvedValueOnce({ items: [{ id: "resolved-plan-id", name: "test-plan-name" }] })
    .mockResolvedValueOnce({});
  mockDdbSend.mockResolvedValueOnce({}); // Put del agente
  mockDdbSend.mockRejectedValueOnce(new Error("no se pudo anotar")); // update best-effort falla

  const result = await handler(eventWith({ code: VALID_CODE }));

  expect(result.statusCode).toBe(201);
});

test("segundo canje en el mismo entorno tibio: no vuelve a llamar GetUsagePlansCommand (cache)", async () => {
  mockDdbSend.mockResolvedValue({ Attributes: { tenantId: "t1" } });
  mockApigwSend
    .mockResolvedValueOnce({ id: "apikey-1", value: "secret-1" })
    .mockResolvedValueOnce({ items: [{ id: "resolved-plan-id", name: "test-plan-name" }] })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ id: "apikey-2", value: "secret-2" })
    .mockResolvedValueOnce({}); // CreateUsagePlanKeyCommand del 2do canje, sin Get de por medio

  await handler(eventWith({ code: VALID_CODE }));
  await handler(eventWith({ code: VALID_CODE }));

  const getUsagePlansCalls = mockApigwSend.mock.calls.filter((c) => c[0].constructor.name === "GetUsagePlansCommand");
  expect(getUsagePlansCalls).toHaveLength(1);
});
