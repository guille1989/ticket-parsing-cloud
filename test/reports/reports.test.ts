import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, REPORTS_TABLE: "TestReports" };
});

import { saveReport, REPORT_RETENTION_DAYS } from "../../src/assistant/reportStore";
import { handler as deleteHandler } from "../../src/reports/deleteHandler";
import { handler as getHandler } from "../../src/reports/getHandler";
import { handler as listHandler } from "../../src/reports/listHandler";

function eventWith(reportId?: string, tenant: string | null = "t1"): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenant ? { "custom:tenantId": tenant } : {} } },
    pathParameters: reportId ? { reportId } : null,
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({});
});

describe("saveReport", () => {
  test("guarda con la clave del tenant y un TTL de 30 días", async () => {
    const now = new Date("2026-10-19T12:00:00.000Z");
    const { reportId, expiresAt } = await saveReport("t1", "resumen", { title: "Ventas" }, now);

    const put = mockDdbSend.mock.calls[0][0].input;
    expect(put.TableName).toBe("TestReports");
    expect(put.Item.pk).toBe("TENANT#t1");
    expect(put.Item.sk).toBe(`REPORT#${reportId}`);
    expect(put.Item.ttl).toBe(Math.floor(now.getTime() / 1000) + REPORT_RETENTION_DAYS * 86400);
    expect(put.Item.summary).toBe("resumen");
    expect(reportId.startsWith("2026-10-19T12:00:00.000Z_")).toBe(true);
    expect(expiresAt).toBe("2026-11-18T12:00:00.000Z");
  });
});

test("saveReport no manda campos undefined a DynamoDB (los rechaza al serializar)", async () => {
  const report = {
    title: "Ventas",
    sections: [{ kind: "kpi", heading: "Total", groupBy: undefined, filters: undefined, previous: undefined, data: [{ value: 1 }] }],
  };
  await saveReport("t1", "resumen", report);

  const stored = mockDdbSend.mock.calls[0][0].input.Item.report as { sections: Array<Record<string, unknown>> };
  expect("groupBy" in stored.sections[0]).toBe(false);
  expect("previous" in stored.sections[0]).toBe(false);
  expect(stored.sections[0].data).toEqual([{ value: 1 }]);
});

describe("GET /reports", () => {
  test("lista del más nuevo al más viejo y descarta los vencidos que DynamoDB todavía no borró", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        { reportId: "vivo", title: "A", createdAt: "2026-10-19T00:00:00.000Z", ttl: nowSeconds() + 1000 },
        { reportId: "vencido", title: "B", createdAt: "2026-09-01T00:00:00.000Z", ttl: nowSeconds() - 10 },
      ],
    });
    const result = await listHandler(eventWith());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.reports.map((r: { reportId: string }) => r.reportId)).toEqual(["vivo"]);
    const query = mockDdbSend.mock.calls[0][0].input;
    expect(query.ExpressionAttributeValues[":pk"]).toBe("TENANT#t1");
    expect(query.ScanIndexForward).toBe(false);
  });

  test("sin sesión: 403 y no toca DynamoDB", async () => {
    const result = await listHandler(eventWith(undefined, null));
    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe("GET /reports/{reportId}", () => {
  test("devuelve el reporte usando la clave del tenant autenticado", async () => {
    mockDdbSend.mockResolvedValue({
      Item: { reportId: "r1", summary: "s", report: { title: "T", sections: [] }, createdAt: "2026-10-19T00:00:00.000Z", ttl: nowSeconds() + 1000 },
    });
    const result = await getHandler(eventWith("r1"));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).report.title).toBe("T");
    expect(mockDdbSend.mock.calls[0][0].input.Key).toEqual({ pk: "TENANT#t1", sk: "REPORT#r1" });
  });

  test("decodifica el reportId que API Gateway entrega codificado (los ':' del timestamp llegan como %3A)", async () => {
    mockDdbSend.mockResolvedValue({ Item: { reportId: "x", summary: "s", report: {}, createdAt: "c", ttl: nowSeconds() + 1000 } });
    await getHandler(eventWith("2026-10-19T16%3A59%3A00.000Z_ab12cd34"));
    expect(mockDdbSend.mock.calls[0][0].input.Key.sk).toBe("REPORT#2026-10-19T16:59:00.000Z_ab12cd34");

    await deleteHandler(eventWith("2026-10-19T16%3A59%3A00.000Z_ab12cd34"));
    expect(mockDdbSend.mock.calls[1][0].input.Key.sk).toBe("REPORT#2026-10-19T16:59:00.000Z_ab12cd34");
  });

  test("inexistente o vencido: 404", async () => {
    mockDdbSend.mockResolvedValueOnce({});
    expect((await getHandler(eventWith("nope"))).statusCode).toBe(404);
    mockDdbSend.mockResolvedValueOnce({ Item: { reportId: "r1", ttl: nowSeconds() - 1 } });
    expect((await getHandler(eventWith("r1"))).statusCode).toBe(404);
  });

  test("sin reportId: 400; sin sesión: 403", async () => {
    expect((await getHandler(eventWith())).statusCode).toBe(400);
    expect((await getHandler(eventWith("r1", null))).statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe("DELETE /reports/{reportId}", () => {
  test("borra con la clave del tenant autenticado", async () => {
    const result = await deleteHandler(eventWith("r1"));
    expect(result.statusCode).toBe(204);
    expect(mockDdbSend.mock.calls[0][0].input.Key).toEqual({ pk: "TENANT#t1", sk: "REPORT#r1" });
  });

  test("sin reportId: 400; sin sesión: 403", async () => {
    expect((await deleteHandler(eventWith())).statusCode).toBe(400);
    expect((await deleteHandler(eventWith("r1", null))).statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});
