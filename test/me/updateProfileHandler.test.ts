import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockGetTenant = jest.fn();
const mockDdbSend = jest.fn();

jest.mock("../../src/shared/tenant", () => ({ getTenant: (...args: unknown[]) => mockGetTenant(...args) }));
jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TENANTS_TABLE: "TestTenants" };
});

import { handler } from "../../src/me/updateProfileHandler";

function eventWith(body: unknown, tenantId = "t1"): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: { "custom:tenantId": tenantId } } },
    body: body === undefined ? null : JSON.stringify(body),
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => {
  mockGetTenant.mockReset();
  mockDdbSend.mockReset();
  mockGetTenant.mockResolvedValue({
    tenantId: "t1",
    businessName: "Café Uno",
    createdAt: "2026-08-12T10:00:00.000Z",
    parserId: "p1",
  });
  mockDdbSend.mockResolvedValue({});
});

test("rechaza sin autenticación", async () => {
  const result = await handler({
    requestContext: { authorizer: { claims: {} } },
    body: JSON.stringify({ currency: "COP" }),
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent);
  expect(result.statusCode).toBe(403);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("persiste currency e industry", async () => {
  const result = await handler(eventWith({ currency: "cop", industry: "restaurante" }));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).profile).toEqual({ currency: "COP", industry: "restaurante" });
  expect(mockDdbSend).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        UpdateExpression: "SET profile = :profile",
        ExpressionAttributeValues: { ":profile": { currency: "COP", industry: "restaurante" } },
      }),
    }),
  );
});

test("merge parcial conserva campos previos", async () => {
  mockGetTenant.mockResolvedValue({
    tenantId: "t1",
    businessName: "Café Uno",
    createdAt: "x",
    profile: { currency: "COP", industry: "café" },
  });
  const result = await handler(eventWith({ openingHours: { default: { open: "08:00", close: "20:00" } } }));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).profile).toEqual({
    currency: "COP",
    industry: "café",
    openingHours: { default: { open: "08:00", close: "20:00" } },
  });
});

test("null borra un campo; si no queda nada, REMOVE profile", async () => {
  mockGetTenant.mockResolvedValue({
    tenantId: "t1",
    businessName: "Café Uno",
    createdAt: "x",
    profile: { currency: "COP" },
  });
  const result = await handler(eventWith({ currency: null }));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).profile).toBeNull();
  expect(mockDdbSend).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ UpdateExpression: "REMOVE profile" }),
    }),
  );
});

test("currency inválida → 400", async () => {
  const result = await handler(eventWith({ currency: "pesos" }));
  expect(result.statusCode).toBe(400);
  expect(JSON.parse(result.body).error).toMatch(/currency/);
  expect(mockDdbSend).not.toHaveBeenCalled();
});

test("horario inválido → 400", async () => {
  const result = await handler(eventWith({ openingHours: { default: { open: "8am", close: "20:00" } } }));
  expect(result.statusCode).toBe(400);
  expect(JSON.parse(result.body).error).toMatch(/open/);
});

test("byWeekday closed se persiste", async () => {
  const result = await handler(
    eventWith({
      openingHours: {
        default: { open: "09:00", close: "18:00" },
        byWeekday: { "7": "closed" },
      },
    }),
  );
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).profile.openingHours.byWeekday["7"]).toBe("closed");
});
