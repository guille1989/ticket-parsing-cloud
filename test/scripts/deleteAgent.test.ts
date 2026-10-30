import { BatchWriteCommand, DeleteCommand, GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteApiKeyCommand, type APIGatewayClient } from "@aws-sdk/client-api-gateway";

import { executeAgentDeletion, LIVE_WINDOW_MS, planAgentDeletion, type DeleteAgentDeps } from "../../scripts/lib/deleteAgent";

const NOW = new Date("2026-10-30T15:00:00Z");
const calls: Array<{ kind: string; input: any }> = [];

const ddbSend = jest.fn();
const apigwSend = jest.fn();

const deps: DeleteAgentDeps = {
  ddb: { send: (c: any) => { calls.push({ kind: `ddb:${c.constructor.name}`, input: c.input }); return ddbSend(c); } } as unknown as DynamoDBDocumentClient,
  apigw: { send: (c: any) => { calls.push({ kind: `apigw:${c.constructor.name}`, input: c.input }); return apigwSend(c); } } as unknown as APIGatewayClient,
  agentsTable: "Agents",
  ticketsTable: "Tickets",
};

const agentItem = { tenantId: "t1", agentId: "a1", name: "Alamo01", version: "0.3.1", apiKeyId: "key123", lastSeenAt: "2026-10-30T10:00:00Z" };

beforeEach(() => {
  calls.length = 0;
  ddbSend.mockReset();
  apigwSend.mockReset();
});

function mockPlanReads(opts: { agent?: object | undefined; commands?: object[]; ticketPages?: number[] } = {}) {
  const pages = opts.ticketPages ?? [0];
  let ticketPage = 0;
  ddbSend.mockImplementation(async (c: any) => {
    if (c instanceof GetCommand) return { Item: "agent" in opts ? opts.agent : agentItem };
    if (c instanceof QueryCommand && c.input.TableName === "Agents") return { Items: opts.commands ?? [] };
    if (c instanceof QueryCommand && c.input.TableName === "Tickets") {
      const count = pages[ticketPage++] ?? 0;
      return { Count: count, LastEvaluatedKey: ticketPage < pages.length ? { pk: "x", sk: "y" } : undefined };
    }
    return {};
  });
}

describe("planAgentDeletion", () => {
  test("arma el plan con api-key, diagnósticos y cantidad de tickets, y no escribe nada", async () => {
    mockPlanReads({ commands: [{ pk: "TENANT#t1", sk: "CMD#a1#1" }, { pk: "TENANT#t1", sk: "CMD#a1#2" }], ticketPages: [3, 4] });

    const plan = await planAgentDeletion(deps, "t1", "a1", NOW);

    expect(plan).toMatchObject({ tenantId: "t1", agentId: "a1", name: "Alamo01", apiKeyId: "key123", ticketCount: 7, live: false });
    expect(plan.commandKeys).toHaveLength(2);
    expect(calls.map((c) => c.kind).every((k) => k === "ddb:GetCommand" || k === "ddb:QueryCommand")).toBe(true);
  });

  test("busca el agente por la clave del tenant y los diagnósticos por el prefijo CMD# de ese agente", async () => {
    mockPlanReads();
    await planAgentDeletion(deps, "t1", "a1", NOW);

    expect(calls[0]!.input.Key).toEqual({ pk: "TENANT#t1", sk: "AGENT#a1" });
    expect(calls[1]!.input.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#t1", ":prefix": "CMD#a1#" });
  });

  test("falla si el agente no existe en ese negocio", async () => {
    mockPlanReads({ agent: undefined });
    await expect(planAgentDeletion(deps, "t1", "otro", NOW)).rejects.toThrow(/no existe/);
  });

  test("marca como conectado un agente visto dentro de la ventana, y no uno más viejo", async () => {
    const recent = new Date(NOW.getTime() - LIVE_WINDOW_MS + 60_000).toISOString();
    mockPlanReads({ agent: { ...agentItem, lastSeenAt: recent } });
    expect((await planAgentDeletion(deps, "t1", "a1", NOW)).live).toBe(true);

    const old = new Date(NOW.getTime() - LIVE_WINDOW_MS - 60_000).toISOString();
    mockPlanReads({ agent: { ...agentItem, lastSeenAt: old } });
    expect((await planAgentDeletion(deps, "t1", "a1", NOW)).live).toBe(false);

    mockPlanReads({ agent: { ...agentItem, lastSeenAt: undefined } });
    expect((await planAgentDeletion(deps, "t1", "a1", NOW)).live).toBe(false);
  });

  test("sin tabla de tickets no cuenta tickets", async () => {
    mockPlanReads();
    const plan = await planAgentDeletion({ ...deps, ticketsTable: undefined }, "t1", "a1", NOW);
    expect(plan.ticketCount).toBeUndefined();
  });
});

describe("executeAgentDeletion", () => {
  const plan = {
    tenantId: "t1", agentId: "a1", name: "Alamo01", apiKeyId: "key123", live: false, ticketCount: 0,
    commandKeys: Array.from({ length: 30 }, (_, i) => ({ pk: "TENANT#t1", sk: `CMD#a1#${i}` })),
  };

  test("borra primero la api-key, luego los diagnósticos en lotes de 25 y al final el agente", async () => {
    ddbSend.mockResolvedValue({});
    apigwSend.mockResolvedValue({});

    await executeAgentDeletion(deps, plan);

    expect(calls.map((c) => c.kind)).toEqual(["apigw:DeleteApiKeyCommand", "ddb:BatchWriteCommand", "ddb:BatchWriteCommand", "ddb:DeleteCommand"]);
    expect(calls[0]!.input).toEqual({ apiKey: "key123" });
    expect(calls[1]!.input.RequestItems.Agents).toHaveLength(25);
    expect(calls[2]!.input.RequestItems.Agents).toHaveLength(5);
    expect(calls[3]!.input).toEqual({ TableName: "Agents", Key: { pk: "TENANT#t1", sk: "AGENT#a1" } });
    // nunca toca tickets ni códigos
    expect(calls.some((c) => c.input.TableName === "Tickets" || c.input.RequestItems?.Tickets)).toBe(false);
  });

  test("si la api-key ya no existe, sigue y borra el registro", async () => {
    ddbSend.mockResolvedValue({});
    apigwSend.mockRejectedValue(Object.assign(new Error("nf"), { name: "NotFoundException" }));

    await executeAgentDeletion(deps, { ...plan, commandKeys: [] });

    expect(calls.at(-1)!.kind).toBe("ddb:DeleteCommand");
  });

  test("si falla el borrado de la api-key por otra razón, aborta SIN tocar el registro", async () => {
    apigwSend.mockRejectedValue(Object.assign(new Error("denegado"), { name: "AccessDeniedException" }));

    await expect(executeAgentDeletion(deps, plan)).rejects.toThrow("denegado");

    expect(calls.map((c) => c.kind)).toEqual(["apigw:DeleteApiKeyCommand"]);
  });

  test("un agente sin api-key solo borra su registro", async () => {
    ddbSend.mockResolvedValue({});
    await executeAgentDeletion(deps, { ...plan, apiKeyId: undefined, commandKeys: [] });
    expect(calls.map((c) => c.kind)).toEqual(["ddb:DeleteCommand"]);
  });
});
