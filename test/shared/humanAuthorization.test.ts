import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockDdbSend = jest.fn();
jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TENANTS_TABLE: "TestTenants" };
});

import { handler as read } from "../../src/read/handler";
import { handler as review } from "../../src/review/handler";
import { handler as image } from "../../src/image/handler";
import { handler as widgetsCreate } from "../../src/widgets/createHandler";
import { handler as widgetsList } from "../../src/widgets/listHandler";
import { handler as widgetsDelete } from "../../src/widgets/deleteHandler";
import { handler as widgetsFields } from "../../src/widgets/fieldsHandler";
import { handler as widgetsData } from "../../src/widgets/dataHandler";
import { handler as agentsList } from "../../src/agents/listHandler";
import { handler as agentsCodes } from "../../src/agents/codesHandler";
import { handler as agentsLocation } from "../../src/agents/updateLocationHandler";
import { handler as me } from "../../src/me/getHandler";
import { handler as onboarding } from "../../src/me/updateOnboardingHandler";
import { handler as assistant } from "../../src/assistant/askHandler";
import { handler as reportsList } from "../../src/reports/listHandler";
import { handler as reportsGet } from "../../src/reports/getHandler";
import { handler as reportsDelete } from "../../src/reports/deleteHandler";
import { handler as conversationsList } from "../../src/conversations/listHandler";
import { handler as conversationGet } from "../../src/conversations/getHandler";
import { handler as conversationDelete } from "../../src/conversations/deleteHandler";
import { handler as conversationSave } from "../../src/conversations/saveHandler";

type HumanHandler = (event: APIGatewayProxyWithCognitoAuthorizerEvent) => Promise<APIGatewayProxyResult>;
const routes: Array<[string, HumanHandler]> = [
  ["GET /tickets", read], ["PATCH /tickets/{ticketId}", review], ["GET /tickets/{ticketId}/image", image],
  ["POST /widgets", widgetsCreate], ["GET /widgets", widgetsList], ["DELETE /widgets/{widgetId}", widgetsDelete],
  ["GET /widgets/fields", widgetsFields], ["GET /widgets/{widgetId}/data", widgetsData],
  ["GET /agents", agentsList], ["GET /activation-codes", agentsCodes], ["PATCH /agents/{agentId}/location", agentsLocation],
  ["GET /me", me], ["PATCH /me/onboarding", onboarding], ["POST /assistant/ask", assistant],
  ["GET /reports", reportsList], ["GET /reports/{reportId}", reportsGet], ["DELETE /reports/{reportId}", reportsDelete],
  ["GET /assistant/conversations", conversationsList], ["GET /assistant/conversations/{conversationId}", conversationGet],
  ["PUT /assistant/conversations/{conversationId}", conversationSave], ["DELETE /assistant/conversations/{conversationId}", conversationDelete],
];

function eventWith(tenantId?: string): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => mockDdbSend.mockReset());

describe.each(routes)("autorización real de %s", (_route, handler) => {
  test("sin JWT no consulta la tabla ni accede a recursos del negocio", async () => {
    expect((await handler(eventWith())).statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test.each([
    ["bloqueado con JWT todavía vigente", { Item: { tenantId: "t1", status: "blocked" } }],
    ["eliminado con JWT todavía vigente", {}],
  ])("un negocio %s no accede a recursos", async (_scenario, lookup) => {
    mockDdbSend.mockResolvedValue(lookup);
    expect((await handler(eventWith("t1"))).statusCode).toBe(403);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend.mock.calls[0][0].input).toEqual({
      TableName: "TestTenants", Key: { pk: "TENANT#t1" }, ConsistentRead: true,
    });
  });

  test("un fallo al verificar el acceso devuelve 403 sin continuar", async () => {
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    mockDdbSend.mockRejectedValue(new Error("unavailable"));
    try {
      expect((await handler(eventWith("t1"))).statusCode).toBe(403);
      expect(mockDdbSend).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
