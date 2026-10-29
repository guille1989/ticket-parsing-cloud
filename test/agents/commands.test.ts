import type { APIGatewayProxyEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
const mockResolveAgent = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, AGENTS_TABLE: "TestAgents" };
});
jest.mock("../../src/shared/agent", () => ({
  resolveAgentByApiKeyId: (...args: unknown[]) => mockResolveAgent(...args),
}));

import { COMMAND_ID_PATTERN, isDiagnosticScriptId, newCommandId } from "../../src/agents/commandCatalog";
import { handler as resultHandler } from "../../src/agents/commandResultHandler";
import { handler as heartbeatHandler } from "../../src/agents/heartbeatHandler";

function heartbeatEvent(): APIGatewayProxyEvent {
  return { body: JSON.stringify({}), requestContext: { identity: { apiKeyId: "key-1" } } } as unknown as APIGatewayProxyEvent;
}

function resultEvent(commandId: string, body: unknown, apiKeyId: string | undefined = "key-1"): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    pathParameters: { commandId },
    requestContext: { identity: { apiKeyId } },
  } as unknown as APIGatewayProxyEvent;
}

const okResult = { exitCode: 0, durationMs: 120, timedOut: false, stdout: "Running", stderr: "" };

beforeEach(() => {
  mockDdbSend.mockReset();
  mockResolveAgent.mockReset();
});

describe("catálogo", () => {
  test("solo acepta ids del catálogo", () => {
    expect(isDiagnosticScriptId("printers")).toBe(true);
    expect(isDiagnosticScriptId("Get-Process")).toBe(false);
    expect(isDiagnosticScriptId("toString")).toBe(false);
    expect(isDiagnosticScriptId(undefined)).toBe(false);
  });

  test("el commandId ordena por fecha y cumple el patrón del path", () => {
    const a = newCommandId(1_700_000_000_000);
    const b = newCommandId(1_700_000_000_001);
    expect(a).toMatch(COMMAND_ID_PATTERN);
    expect(a < b).toBe(true);
  });
});

describe("heartbeat entrega comandos", () => {
  test("devuelve los pendientes (el más viejo primero) y los marca delivered con condición", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    const now = new Date().toISOString();
    mockDdbSend
      .mockResolvedValueOnce({}) // update lastSeenAt
      .mockResolvedValueOnce({
        Items: [
          { commandId: "1700000000002-bbbbbb", scriptId: "network", status: "pending", createdAt: now },
          { commandId: "1700000000001-aaaaaa", scriptId: "printers", status: "pending", createdAt: now },
          { commandId: "1700000000000-cccccc", scriptId: "spooler", status: "done", createdAt: now },
        ],
      })
      .mockResolvedValue({});

    const result = await heartbeatHandler(heartbeatEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).commands).toEqual([
      { commandId: "1700000000001-aaaaaa", scriptId: "printers" },
      { commandId: "1700000000002-bbbbbb", scriptId: "network" },
    ]);
    const query = mockDdbSend.mock.calls[1][0].input;
    expect(query.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#t1", ":prefix": "CMD#a1#" });
    const claim = mockDdbSend.mock.calls[2][0].input;
    expect(claim.ConditionExpression).toBe("#status = :pending");
    expect(claim.Key).toEqual({ pk: "TENANT#t1", sk: "CMD#a1#1700000000001-aaaaaa" });
  });

  test("sin pendientes responde 204 como antes", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    mockDdbSend.mockResolvedValue({});

    const result = await heartbeatHandler(heartbeatEvent());

    expect(result.statusCode).toBe(204);
  });

  test("no entrega un comando que otro heartbeat ya reclamó", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    const now = new Date().toISOString();
    mockDdbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ commandId: "1700000000001-aaaaaa", scriptId: "printers", status: "pending", createdAt: now }] })
      .mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));

    const result = await heartbeatHandler(heartbeatEvent());

    expect(result.statusCode).toBe(204);
  });

  test("descarta pedidos viejos (agente que estuvo caído)", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    mockDdbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ commandId: "1700000000001-aaaaaa", scriptId: "printers", status: "pending", createdAt: "2020-01-01T00:00:00Z" }] });

    const result = await heartbeatHandler(heartbeatEvent());

    expect(result.statusCode).toBe(204);
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
  });

  test("si falla leer los comandos, el heartbeat igual responde 204", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockDdbSend.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("throttled"));

    const result = await heartbeatHandler(heartbeatEvent());

    expect(result.statusCode).toBe(204);
  });
});

describe("resultado del agente", () => {
  test("guarda la salida en el comando del propio agente y lo marca done", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    mockDdbSend.mockResolvedValue({});

    const result = await resultHandler(resultEvent("1700000000001-aaaaaa", okResult));

    expect(result.statusCode).toBe(204);
    const input = mockDdbSend.mock.calls[0][0].input;
    expect(input.Key).toEqual({ pk: "TENANT#t1", sk: "CMD#a1#1700000000001-aaaaaa" });
    expect(input.ConditionExpression).toBe("#status = :delivered");
    expect(input.ExpressionAttributeValues).toMatchObject({ ":status": "done", ":stdout": "Running" });
  });

  test("exit code distinto de 0 o timeout queda failed", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    mockDdbSend.mockResolvedValue({});

    await resultHandler(resultEvent("1700000000001-aaaaaa", { ...okResult, exitCode: 1 }));
    await resultHandler(resultEvent("1700000000001-aaaaaa", { ...okResult, timedOut: true }));

    expect(mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues[":status"]).toBe("failed");
    expect(mockDdbSend.mock.calls[1][0].input.ExpressionAttributeValues[":status"]).toBe("failed");
  });

  test("recorta salidas enormes", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    mockDdbSend.mockResolvedValue({});

    await resultHandler(resultEvent("1700000000001-aaaaaa", { ...okResult, stdout: "x".repeat(500_000) }));

    expect(mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues[":stdout"]).toHaveLength(60_000);
  });

  test("404 si el comando ya se resolvió o no existe", async () => {
    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    mockDdbSend.mockRejectedValue(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));

    const result = await resultHandler(resultEvent("1700000000001-aaaaaa", okResult));

    expect(result.statusCode).toBe(404);
  });

  test("rechaza una key sin agente, un id mal formado y un resultado inválido", async () => {
    mockResolveAgent.mockResolvedValueOnce(undefined);
    expect((await resultHandler(resultEvent("1700000000001-aaaaaa", okResult))).statusCode).toBe(403);

    mockResolveAgent.mockResolvedValue({ tenantId: "t1", agentId: "a1" });
    expect((await resultHandler(resultEvent("../AGENT#a2", okResult))).statusCode).toBe(400);
    expect((await resultHandler(resultEvent("1700000000001-aaaaaa", { exitCode: "0" }))).statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});
