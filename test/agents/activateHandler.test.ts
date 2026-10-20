import { ConflictException } from "@aws-sdk/client-api-gateway";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { handler as HandlerType, validateBody as ValidateBodyType } from "../../src/agents/activateHandler";

/**
 * Mundo simulado en memoria: DynamoDB (códigos y agentes) y API Gateway (keys y usage
 * plan). Permite probar la activación como flujo —incluidos los fallos a mitad de
 * camino y los reintentos— en vez de encadenar respuestas sueltas.
 */
const codes = new Map<string, Record<string, any>>();
const agents = new Map<string, Record<string, any>>();
let apiKeys: Array<{ id: string; name: string; value: string }> = [];
let planLinks = new Set<string>();
let injected: Record<string, Error[]> = {};
let keyCounter = 0;
let emptyKeyResponse = false;
let usagePlanLookups = 0;

/** Hace fallar la próxima ejecución del comando indicado (una sola vez). */
const failOnce = (command: string, error = new Error(`${command} falló`)) => {
  (injected[command] ??= []).push(error);
};
const maybeFail = (command: string) => {
  const error = injected[command]?.shift();
  if (error) throw error;
};

const conditionalFailure = () => new ConditionalCheckFailedException({ message: "condición", $metadata: {} });

function fakeDdb(command: any) {
  const name = command.constructor.name as string;
  const input = command.input;
  const values = input.ExpressionAttributeValues ?? {};
  maybeFail(name + ":" + input.TableName);

  if (name === "UpdateCommand") {
    const code = codes.get(input.Key.pk);
    if (values[":nowMs"] !== undefined) {
      // Reclamo: existe y (sin usar, o en curso con el lease vencido).
      const claimable = code && (code.status === "unused" || (code.status === "activating" && code.activatingUntil < values[":nowMs"]));
      if (!claimable) throw conditionalFailure();
      code.status = "activating";
      code.activatingUntil = values[":until"];
      code.agentId ??= values[":agentId"];
      return { Attributes: { ...code } };
    }
    // Cierre del canje.
    maybeFail("close");
    code!.status = "used";
    code!.usedAt = values[":now"];
    code!.agentId = values[":agentId"];
    delete code!.activatingUntil;
    return {};
  }
  if (name === "GetCommand") {
    const store = input.TableName === "TestAgents" ? agents : codes;
    const key = input.TableName === "TestAgents" ? input.Key.sk : input.Key.pk;
    return { Item: store.get(key) ? { ...store.get(key) } : undefined };
  }
  if (name === "PutCommand") {
    if (agents.has(input.Item.sk)) throw conditionalFailure();
    agents.set(input.Item.sk, input.Item);
    return {};
  }
  throw new Error(`comando de DynamoDB no simulado: ${name}`);
}

function fakeApigw(command: any) {
  const name = command.constructor.name as string;
  const input = command.input;
  maybeFail(name);

  if (name === "GetApiKeysCommand") {
    return { items: apiKeys.filter((k) => k.name.startsWith(input.nameQuery)) };
  }
  if (name === "CreateApiKeyCommand") {
    if (emptyKeyResponse) return {};
    const key = { id: `key-${++keyCounter}`, name: input.name, value: `secret-${keyCounter}` };
    apiKeys.push(key);
    return { ...key };
  }
  if (name === "GetUsagePlansCommand") usagePlanLookups++;
  if (name === "GetUsagePlansCommand") return { items: [{ id: "plan-1", name: "test-plan-name" }] };
  if (name === "CreateUsagePlanKeyCommand") {
    if (planLinks.has(input.keyId)) throw new ConflictException({ message: "ya vinculada", $metadata: {} });
    planLinks.add(input.keyId);
    return {};
  }
  throw new Error(`comando de API Gateway no simulado: ${name}`);
}

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return {
    ...actual,
    ddb: { send: async (command: unknown) => fakeDdb(command) },
    AGENTS_TABLE: "TestAgents",
    ACTIVATION_CODES_TABLE: "TestActivationCodes",
  };
});

jest.mock("@aws-sdk/client-api-gateway", () => {
  const actual = jest.requireActual("@aws-sdk/client-api-gateway");
  return {
    ...actual,
    APIGatewayClient: jest.fn().mockImplementation(() => ({ send: async (command: unknown) => fakeApigw(command) })),
  };
});

const VALID_CODE = "ABCDE-FGHJK";
const T0 = Date.parse("2026-10-20T12:00:00.000Z");

function eventWith(body: unknown): APIGatewayProxyEvent {
  return { body: body === undefined ? null : JSON.stringify(body) } as unknown as APIGatewayProxyEvent;
}

const activate = (body: unknown = { code: VALID_CODE }) => handler(eventWith(body));
const code = () => codes.get(`CODE#${VALID_CODE}`)!;

let now = T0;
/** Avanza el reloj simulado (afecta a `Date.now()` y a `new Date()`). */
const advance = (ms: number) => {
  now += ms;
  jest.setSystemTime(now);
};
let handler: typeof HandlerType;
let validateBody: typeof ValidateBodyType;

beforeEach(() => {
  // `resolveUsagePlanId()` cachea el id a nivel de módulo (así un Lambda "tibio" no
  // lo vuelve a buscar): sin `resetModules` esa cache sobreviviría entre tests.
  jest.resetModules();
  codes.clear();
  agents.clear();
  apiKeys = [];
  planLinks = new Set();
  injected = {};
  keyCounter = 0;
  emptyKeyResponse = false;
  usagePlanLookups = 0;
  now = T0;
  jest.useFakeTimers({ now: T0 });
  codes.set(`CODE#${VALID_CODE}`, { pk: `CODE#${VALID_CODE}`, tenantId: "t1", code: VALID_CODE, status: "unused", createdAt: "2026-10-01T00:00:00.000Z" });
  process.env.USAGE_PLAN_NAME = "test-plan-name";
  ({ handler, validateBody } = require("../../src/agents/activateHandler"));
});

afterEach(() => jest.useRealTimers());

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
  const result = await handler({ body: "{esto no es json" } as unknown as APIGatewayProxyEvent);
  expect(result.statusCode).toBe(400);
  expect(code().status).toBe("unused");
});

test("code con formato inválido: 400, no toca el código", async () => {
  const result = await activate({ code: "xxxxx" });
  expect(result.statusCode).toBe(400);
  expect(code().status).toBe("unused");
});

test("código inexistente: 403 genérico", async () => {
  const result = await activate({ code: "ZZZZZ-ZZZZZ" });
  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body).error).toBe("código inválido o ya usado");
});

test("canje exitoso: una key, un agente, el código queda usado con su agentId", async () => {
  const result = await activate({ code: VALID_CODE, name: "Caja 1" });

  expect(result.statusCode).toBe(201);
  const body = JSON.parse(result.body);
  expect(body).toMatchObject({ name: "Caja 1", apiKey: "secret-1" });
  expect(code()).toMatchObject({ status: "used", agentId: body.agentId });
  expect(code().activatingUntil).toBeUndefined();

  expect(apiKeys).toHaveLength(1);
  expect(apiKeys[0].name).toBe(`agent-${body.agentId}`);
  expect([...planLinks]).toEqual(["key-1"]); // la key quedó asociada al usage plan
  expect(agents.get(`AGENT#${body.agentId}`)).toMatchObject({ tenantId: "t1", apiKeyId: "key-1", name: "Caja 1" });
});

test("sin name: genera uno por default a partir del agentId", async () => {
  const body = JSON.parse((await activate()).body);
  expect(body.name).toBe(`Robot ${body.agentId.slice(0, 8)}`);
});

test("segundo canje del mismo código ya completado y fuera de ventana: 403, sin crear nada", async () => {
  const first = JSON.parse((await activate()).body);
  advance(16 * 60_000);

  const second = await activate();

  expect(second.statusCode).toBe(403);
  expect(apiKeys).toHaveLength(1);
  expect(agents.size).toBe(1);
  expect(first.agentId).toBe(code().agentId);
});

test("un error de DynamoDB que NO es de condición se propaga", async () => {
  failOnce("UpdateCommand:TestActivationCodes");
  await expect(activate()).rejects.toThrow(/falló/);
});

describe("fallos a mitad de la activación: el reintento reanuda, no gasta otro código", () => {
  test("falla al vincular la key al usage plan: el reintento usa el MISMO agente y la MISMA key", async () => {
    failOnce("CreateUsagePlanKeyCommand");

    await expect(activate()).rejects.toThrow();
    // El código quedó reservado para un agente concreto, no gastado a ciegas.
    expect(code().status).toBe("activating");
    const reservedAgentId = code().agentId;
    expect(reservedAgentId).toEqual(expect.any(String));
    expect(agents.size).toBe(0);

    advance(31_000); // vence el lease
    const retry = await activate();

    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(retry.body).agentId).toBe(reservedAgentId);
    expect(apiKeys).toHaveLength(1); // no quedó una key huérfana ni se creó otra
    expect(agents.size).toBe(1);
    expect(code().status).toBe("used");
  });

  test("falla al guardar el agente después de crear la key: el reintento reutiliza la key", async () => {
    failOnce("PutCommand:TestAgents");

    await expect(activate({ code: VALID_CODE, name: "Caja 2" })).rejects.toThrow();
    expect(apiKeys).toHaveLength(1);

    advance(31_000);
    const retry = JSON.parse((await activate({ code: VALID_CODE, name: "Caja 2" })).body);

    expect(apiKeys).toHaveLength(1);
    expect(retry.apiKey).toBe(apiKeys[0].value);
    expect(agents.size).toBe(1);
    expect(code()).toMatchObject({ status: "used", agentId: retry.agentId });
  });

  test("falla al cerrar el código tras crearlo todo: el reintento termina sin duplicar nada", async () => {
    failOnce("close", new Error("cierre falló"));

    await expect(activate()).rejects.toThrow("cierre falló");
    expect(code().status).toBe("activating");
    expect(agents.size).toBe(1);
    expect(apiKeys).toHaveLength(1);

    advance(31_000);
    const retry = await activate();

    expect(retry.statusCode).toBe(201);
    expect(apiKeys).toHaveLength(1);
    expect(agents.size).toBe(1);
    expect(code().status).toBe("used");
  });

  test("reintento mientras la activación anterior sigue vigente (lease): 409 y no hace nada", async () => {
    failOnce("CreateUsagePlanKeyCommand");
    await expect(activate()).rejects.toThrow();
    const keysBefore = apiKeys.length;

    advance(5_000); // el lease (30 s) sigue vigente
    const retry = await activate();

    expect(retry.statusCode).toBe(409);
    expect(apiKeys).toHaveLength(keysBefore);
    expect(code().status).toBe("activating");
  });

  test("dos reintentos tras el fallo: solo uno completa y el otro ve el código usado", async () => {
    failOnce("CreateUsagePlanKeyCommand");
    await expect(activate()).rejects.toThrow();
    advance(31_000);

    const results = [await activate(), await activate()];

    expect(results[0].statusCode).toBe(201);
    // La segunda llamada ya cae en la recuperación del mismo agente (no uno nuevo).
    expect(JSON.parse(results[1].body).agentId).toBe(JSON.parse(results[0].body).agentId);
    expect(apiKeys).toHaveLength(1);
    expect(agents.size).toBe(1);
  });
});

describe("respuesta perdida (corte de conexión después de completar)", () => {
  test("reintento con el mismo código recupera el MISMO agente y key, sin crear otro", async () => {
    const lost = JSON.parse((await activate({ code: VALID_CODE, name: "Caja 1" })).body);
    advance(60_000);

    const retry = await activate({ code: VALID_CODE, name: "Caja 1" });

    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(retry.body)).toEqual(lost);
    expect(apiKeys).toHaveLength(1);
    expect(agents.size).toBe(1);
  });

  test("si el agente ya envió su primer heartbeat, la credencial se entregó: 403", async () => {
    const first = JSON.parse((await activate()).body);
    agents.get(`AGENT#${first.agentId}`)!.lastSeenAt = new Date(now).toISOString();

    const retry = await activate();

    expect(retry.statusCode).toBe(403);
    expect(agents.size).toBe(1);
  });

  test("pasada la ventana de recuperación, un código usado vuelve a ser inútil", async () => {
    await activate();
    advance(16 * 60_000);
    expect((await activate()).statusCode).toBe(403);
  });
});

test("si la API key no trae id/value: falla antes de crear un agente sin credencial", async () => {
  emptyKeyResponse = true;

  await expect(activate()).rejects.toThrow(/API key/);

  expect(agents.size).toBe(0);
  expect(code().status).toBe("activating"); // reservado para reanudar, no gastado
});

test("segundo canje (otro código) en el mismo entorno tibio: no vuelve a buscar el usage plan", async () => {
  codes.set("CODE#BBBBB-CCCCC", { pk: "CODE#BBBBB-CCCCC", tenantId: "t1", code: "BBBBB-CCCCC", status: "unused", createdAt: "2026-10-01T00:00:00.000Z" });

  await activate();
  await activate({ code: "BBBBB-CCCCC" });

  expect(usagePlanLookups).toBe(1);
});
