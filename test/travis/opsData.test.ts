const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return {
    ...actual,
    ddb: { send: (...args: unknown[]) => mockDdbSend(...args) },
    TENANTS_TABLE: "TestTenants",
    TICKETS_TABLE: "TestTickets",
    AGENTS_TABLE: "TestAgents",
  };
});

import { listTravisTenants, loadAgents, loadRecentTickets, loadReviewQueue } from "../../src/travis/opsData";

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("listTravisTenants salta los bloqueados y los registros a medio crear, y sigue la paginación", async () => {
  mockDdbSend
    .mockResolvedValueOnce({
      Items: [
        { tenantId: "t1", businessName: "Alamo", travis: { timeZone: "America/Bogota" } },
        { tenantId: "t2", businessName: "Bloqueado", status: "blocked" },
      ],
      LastEvaluatedKey: { pk: "TENANT#t2" },
    })
    .mockResolvedValueOnce({ Items: [{ tenantId: "t3", businessName: "Nuevo", signupState: "provisioning" }, { tenantId: "t4", businessName: "Empanadas" }] });

  const tenants = await listTravisTenants();

  expect(tenants).toEqual([
    { tenantId: "t1", businessName: "Alamo", travis: { timeZone: "America/Bogota" } },
    { tenantId: "t4", businessName: "Empanadas", travis: undefined },
  ]);
  expect(mockDdbSend).toHaveBeenCalledTimes(2);
});

test("loadAgents consulta solo los AGENT# del tenant", async () => {
  mockDdbSend.mockResolvedValue({ Items: [{ agentId: "a1", name: "Caja 1" }] });

  expect(await loadAgents("t1")).toEqual([{ agentId: "a1", name: "Caja 1" }]);
  expect(mockDdbSend.mock.calls[0][0].input).toMatchObject({
    TableName: "TestAgents",
    ExpressionAttributeValues: { ":pk": "TENANT#t1", ":prefix": "AGENT#" },
  });
});

describe("loadReviewQueue", () => {
  it("cola vacía: no hace la segunda consulta", async () => {
    mockDdbSend.mockResolvedValue({ Count: 0 });

    expect(await loadReviewQueue("t1")).toEqual({ count: 0 });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("suma el conteo de todas las páginas y trae el capturedAt del más viejo", async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Count: 40, LastEvaluatedKey: { gsi1pk: "x" } })
      .mockResolvedValueOnce({ Count: 5 })
      .mockResolvedValueOnce({ Items: [{ gsi1sk: "2026-10-30T15:00:00.000Z" }] });

    expect(await loadReviewQueue("t1")).toEqual({ count: 45, oldestCapturedAt: "2026-10-30T15:00:00.000Z" });
    const [, , oldestCall] = mockDdbSend.mock.calls.map(([cmd]) => cmd.input);
    expect(oldestCall).toMatchObject({
      IndexName: "status-index",
      ScanIndexForward: true,
      ExpressionAttributeValues: { ":gsi1pk": "TENANT#t1#STATUS#needs_review" },
    });
    // `Limit` se aplica antes del filtro: pediría una página vacía aunque haya coincidencias.
    expect(oldestCall).not.toHaveProperty("Limit");
  });

  it("no cuenta los tickets leídos por visión (la cola de un POS-imagen nunca se vacía por diseño)", async () => {
    mockDdbSend.mockResolvedValue({ Count: 0 });

    await loadReviewQueue("t1");

    const input = mockDdbSend.mock.calls[0][0].input;
    expect(input.FilterExpression).toBe("attribute_not_exists(parsedBy) OR parsedBy <> :vision");
    expect(input.ExpressionAttributeValues[":vision"]).toBe("bedrock-vision");
  });

  it("si la primera página del más viejo viene vacía por el filtro, sigue con la siguiente", async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Count: 2 })
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { gsi1pk: "x" } })
      .mockResolvedValueOnce({ Items: [{ gsi1sk: "2026-11-01T10:00:00.000Z" }] });

    expect(await loadReviewQueue("t1")).toEqual({ count: 2, oldestCapturedAt: "2026-11-01T10:00:00.000Z" });
    expect(mockDdbSend).toHaveBeenCalledTimes(3);
  });
});

test("loadRecentTickets usa un rango sobre el SK cronológico, sin tocar los marcadores DEDUP#", async () => {
  mockDdbSend.mockResolvedValue({ Items: [{ agentId: "a1", capturedAt: "2026-11-03T14:00:00.000Z", status: "parsed" }] });

  const tickets = await loadRecentTickets("t1", "2026-11-03T12:00:00.000Z");

  expect(tickets).toHaveLength(1);
  expect(mockDdbSend.mock.calls[0][0].input).toMatchObject({
    TableName: "TestTickets",
    // Un solo BETWEEN sobre el SK: DynamoDB rechaza dos condiciones sobre la misma clave de ordenamiento.
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :since AND :until",
    ExpressionAttributeValues: { ":pk": "TENANT#t1", ":since": "TICKET#2026-11-03T12:00:00.000Z", ":until": "TICKET$" },
  });
});
